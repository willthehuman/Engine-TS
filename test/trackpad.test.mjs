import test from 'node:test';
import assert from 'node:assert/strict';

import { clampCursor, cursorToCss, classifyTap, SENSITIVITY } from '../public/trackpad.js';

test('clampCursor clamps into 765x503 and floors floats', () => {
    assert.deepEqual(clampCursor(-10, 700), { x: 0, y: 503 });
    assert.deepEqual(clampCursor(800, -5), { x: 765, y: 0 });
    assert.deepEqual(clampCursor(100.9, 200.9), { x: 100, y: 200 });
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

test('clampCursor center is reachable and symmetric', () => {
    const c = clampCursor(765 / 2, 503 / 2);
    assert.deepEqual(c, { x: 382, y: 251 });
});
