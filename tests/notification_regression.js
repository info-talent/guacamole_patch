#!/usr/bin/env node
'use strict';

// Exercise the actual patched Angular controller with deferred translation and
// authentication requests, including callbacks which arrive after recovery.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourceRoot = process.argv[2];
if (!sourceRoot)
    throw new Error('Usage: node notification_regression.js <patched-source-dir>');
const source = fs.readFileSync(path.join(sourceRoot,
    'guacamole/src/main/frontend/src/app/client/directives/guacClientNotification.js'), 'utf8');

const flush = async () => {
    for (let i = 0; i < 6; i++)
        await Promise.resolve();
};

function createHarness() {
    const translations = [];
    const authentications = [];
    const replacements = [];
    const refreshes = [];
    const events = {};
    let stateChanged;
    let directive;
    const scope = {
        client: {
            id: 'current-connection',
            clientState: { connectionState: 'CONNECTED', statusCode: 0x0200 },
            clientProperties: { focused: true }
        },
        $watchGroup: (names, callback) => { stateChanged = callback; },
        $on: (name, callback) => { events[name] = callback; }
    };
    const ConnectionState = Object.fromEntries([
        'CONNECTING', 'WAITING', 'CONNECTED', 'DISCONNECTED', 'CLIENT_ERROR', 'TUNNEL_ERROR'
    ].map(name => [name, name]));
    const services = {
        ManagedClient: { sendArguments() {} },
        ManagedClientState: { ConnectionState },
        Protocol: { getNamespace: protocol => protocol },
        $location: { path: () => '/client/current', search: () => ({}), url() {} },
        authenticationService: {
            updateCurrentToken: () => new Promise(resolve => authentications.push(resolve)),
            logout: () => Promise.resolve()
        },
        guacClientManager: {
            replaceManagedClient: id => {
                replacements.push(id);
                return { ...scope.client, clientState: { connectionState: 'CONNECTING' } };
            }
        },
        guacTranslate: () => new Promise(resolve => translations.push(resolve)),
        preferenceService: {
            preferences: { automaticRefresh: false },
            canAutomaticallyRefresh: () => true,
            refreshPage: manual => refreshes.push(manual)
        },
        requestService: { IGNORE() {}, WARN() {} },
        userPageService: { getHomePage: () => Promise.resolve({ url: '/' }) }
    };
    vm.runInNewContext(source, {
        angular: { module: () => ({ directive: (name, definition) => {
            directive = definition[definition.length - 1]();
        } }) }
    });
    directive.controller[directive.controller.length - 1](scope,
        { get: name => {
            assert.ok(name in services, `Unexpected dependency: ${name}`);
            return services[name];
        } }, [{}]);

    const changeState = (state, code = scope.client.clientState.statusCode) => {
        scope.client.clientState.connectionState = state;
        scope.client.clientState.statusCode = code;
        stateChanged([state, scope.client.requiredParameters, scope.client.protocol, scope.client.forms, code]);
    };
    const finishTranslations = async () => {
        while (translations.length)
            translations.shift()({ id: 'TEST_ERROR' });
        await flush();
    };
    const finishAuthentication = async () => {
        while (authentications.length)
            authentications.shift()();
        await flush();
    };
    return { scope, events, replacements, refreshes, services, changeState,
        finishTranslations, finishAuthentication };
}

(async () => {
    for (const state of ['CLIENT_ERROR', 'TUNNEL_ERROR', 'DISCONNECTED']) {
        const h = createHarness();
        await flush();
        h.changeState(state);
        await h.finishTranslations();
        await h.finishAuthentication();
        assert.ok(h.scope.status, `${state}: a real disconnection must remain visible`);
        assert.equal(h.scope.status.actions.find(a => /RECONNECT|REFRESH_PAGE/.test(a.name)).name,
            'CLIENT.ACTION_RECONNECT', 'Reconnect the affected client as the primary action');
        assert.equal(h.scope.status.countdown, undefined, 'No duplicate automatic page refresh countdown');
        h.scope.status.actions.find(a => a.name === 'CLIENT.ACTION_RECONNECT').callback();
        assert.deepEqual(h.replacements, ['current-connection']);
        assert.deepEqual(h.refreshes, []);
        assert.equal(h.scope.status, false);
    }

    // An old translation must not start a stale error dialog after recovery.
    const translatedLate = createHarness();
    translatedLate.changeState('TUNNEL_ERROR');
    translatedLate.changeState('CONNECTED');
    await translatedLate.finishTranslations();
    await translatedLate.finishAuthentication();
    assert.equal(translatedLate.scope.status, false, 'Late translation reopened an error dialog');

    // Authentication can finish after the client is already usable again.
    const authenticatedLate = createHarness();
    authenticatedLate.changeState('CLIENT_ERROR');
    await authenticatedLate.finishTranslations();
    authenticatedLate.changeState('CONNECTED');
    await authenticatedLate.finishAuthentication();
    assert.equal(authenticatedLate.scope.status, false, 'Late authentication reopened an error dialog');
    let blocked = false;
    authenticatedLate.events.guacBeforeKeydown({ preventDefault: () => { blocked = true; } });
    assert.equal(blocked, false, 'A recovered connection must accept keyboard input');

    // Deferred callbacks also belong to the original client and view lifetime.
    const replaced = createHarness();
    replaced.changeState('TUNNEL_ERROR');
    await replaced.finishTranslations();
    replaced.scope.client = { ...replaced.scope.client };
    await replaced.finishAuthentication();
    assert.equal(replaced.scope.status, false, 'Old client callback leaked into its replacement');
    const changedCode = createHarness();
    changedCode.changeState('CLIENT_ERROR', 0x0200);
    await changedCode.finishTranslations();
    changedCode.scope.client.clientState.statusCode = 0x0202;
    await changedCode.finishAuthentication();
    assert.equal(changedCode.scope.status, false, 'Old error overwrote a newer status code before the next digest');
    const destroyed = createHarness();
    destroyed.changeState('TUNNEL_ERROR');
    await destroyed.finishTranslations();
    destroyed.events.$destroy?.();
    await destroyed.finishAuthentication();
    assert.equal(destroyed.scope.status, false, 'Destroyed view received a stale dialog');

    // A newer parameter form must not be overwritten by a previous error.
    const parameters = createHarness();
    parameters.changeState('TUNNEL_ERROR');
    await parameters.finishTranslations();
    parameters.scope.client.requiredParameters = { password: '' };
    parameters.scope.client.protocol = 'rdp';
    parameters.scope.client.forms = [];
    parameters.changeState('WAITING');
    await parameters.finishAuthentication();
    assert.equal(parameters.scope.status.className, 'parameters-required');

    // Refresh stays an explicit fallback, including while awaiting the first frame.
    const manual = createHarness();
    manual.changeState('DISCONNECTED');
    await manual.finishAuthentication();
    manual.scope.status.actions.find(a => a.name === 'CLIENT.ACTION_REFRESH_PAGE').callback();
    assert.deepEqual(manual.refreshes, [true]);
    const waiting = createHarness();
    waiting.changeState('WAITING');
    waiting.scope.status.actions.find(a => a.name === 'CLIENT.ACTION_REFRESH_PAGE').callback();
    assert.deepEqual(waiting.refreshes, [true]);

    // Run the actual tunnel handler to verify that recovery clears a stale
    // network suggestion while preserving a separately detected control stall.
    const managedSource = fs.readFileSync(path.join(sourceRoot,
        'guacamole/src/main/frontend/src/app/client/types/ManagedClient.js'), 'utf8');
    const tunnelHandler = managedSource.match(/tunnel\.onstatechange = function tunnelStateChanged\(state\) \{[\s\S]*?\n        \};/);
    assert.ok(tunnelHandler, 'ManagedClient tunnel state handler must be present');
    const tunnel = {};
    const managedClient = { clientState: {}, reconnectSuggested: true, controlUnresponsive: false };
    vm.runInNewContext(tunnelHandler[0], {
        tunnel, managedClient,
        Guacamole: { Tunnel: { State: { OPEN: 1 } } },
        $rootScope: { $evalAsync: callback => callback() },
        endUnstableWarning: () => { managedClient.clientState.tunnelUnstable = false; }
    });
    tunnel.onstatechange(1);
    assert.equal(managedClient.reconnectSuggested, false, 'Recovered tunnel kept a stale refresh suggestion');
    managedClient.controlUnresponsive = true;
    managedClient.reconnectSuggested = true;
    tunnel.onstatechange(1);
    assert.equal(managedClient.reconnectSuggested, true, 'Tunnel recovery hid a real control stall');
    console.log('Notification regression passed: reconnect, stale callbacks, input, forms, manual refresh, tunnel recovery.');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
