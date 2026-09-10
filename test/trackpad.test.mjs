import test from 'node:test';
import assert from 'node:assert/strict';

import { clampCursor, cursorToCss, classifyTap, cursorGain, ACCEL_MAX, SENSITIVITY } from '../public/trackpad.js';

test('clampCursor clamps into 765x503 and preserves fractional positions', () => {
    assert.deepEqual(clampCursor(-10, 700), { x: 0, y: 503 });
    assert.deepEqual(clampCursor(800, -5), { x: 765, y: 0 });
    assert.deepEqual(clampCursor(100.9, 200.9), { x: 100.9, y: 200.9 });
});

test('cursorToCss maps client coords onto the canvas rect exactly', () => {
    const rect = { left: 10, top: 20, width: 1530, height: 1006 }; // 2x scale
    assert.deepEqual(cursorToCss(0, 0, rect), { x: 10, y: 20 });
    assert.deepEqual(cursorToCss(765, 503, rect), { x: 1540, y: 1026 });
    assert.deepEqual(cursorToCss(382.5, 251.5, rect), { x: 775, y: 523 });
});

test('classifyTap: quick 1-pointer = LMB(1)', () => {
    assert.equal(classifyTap(1, 120, 4), 1);
});

test('classifyTap: quick 2-pointer = RMB(2)', () => {
    assert.equal(classifyTap(2, 120, 4), 2);
});

test('classifyTap: slow or dragged = no click(0)', () => {
    assert.equal(classifyTap(1, 400, 3), 0);
    assert.equal(classifyTap(2, 100, 30), 0);
});

test('sensitivity is applied before clamping (cursor pins at edge)', () => {
    const { x } = clampCursor(760 + 10 * SENSITIVITY, 100);
    assert.equal(x, 765);
});

test('clampCursor center is reachable', () => {
    const c = clampCursor(765 / 2, 503 / 2);
    assert.deepEqual(c, { x: 382.5, y: 251.5 });
});

test('slow sub-pixel motion accumulates instead of flooring away', () => {
    // 10 moves of 0.4 client-px at gain 1: old flooring lost ALL of it
    let x = 382.5;
    for (let i = 0; i < 10; i++) {
        x = clampCursor(x + 0.4, 0).x;
    }
    assert.ok(Math.abs(x - 386.5) < 1e-9, `expected ~386.5, got ${x}`);
});

test('cursorGain: ~1 at slow speeds, saturates at ACCEL_MAX', () => {
    assert.ok(Math.abs(cursorGain(0.1) - 1) < 0.05, 'slow movement gets ~no boost');
    assert.ok(cursorGain(0) >= 1 && cursorGain(0.1) >= 1);
    assert.ok(cursorGain(0.5) < cursorGain(1.5), 'increases with speed');
    assert.equal(cursorGain(1.5), 1 + (ACCEL_MAX - 1), 'curve tops out at 1.5 px/ms');
    assert.equal(cursorGain(100), 1 + (ACCEL_MAX - 1), 'fast flick saturates');
});
