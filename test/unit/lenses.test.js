// Which lens each camera is, the order they're offered in, and their names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lensKind, orderCameras, nameCameras, lensNote } from '../../docs/js/lenses.js';
import { LOCALES } from '../../docs/js/i18n.js';

const en = LOCALES.en;
const label = ({ key, vars }) => en[key].replace('{n}', vars?.n);

// What browsers report, as { label, facing } after the app has guessed facing.
const cam = (deviceId, label, facing) => ({ deviceId, facing, kind: lensKind(label) });
const names = (cameras) => {
  const ordered = orderCameras(cameras);
  return nameCameras(ordered).map(label);
};

test('lens type from the camera name', () => {
  assert.equal(lensKind('Back Ultra Wide Camera'), 'ultrawide');
  assert.equal(lensKind('Back Telephoto Camera'), 'tele');
  assert.equal(lensKind('Back Dual Wide Camera'), 'multi');
  assert.equal(lensKind('Back Triple Camera'), 'multi');
  assert.equal(lensKind('Back Dual Camera'), 'multi');
  assert.equal(lensKind('Back Camera'), '');
  assert.equal(lensKind('Front Camera'), '');
  assert.equal(lensKind('后置超广角相机'), 'ultrawide');
  assert.equal(lensKind('后置长焦相机'), 'tele');
  assert.equal(lensKind('Caméra arrière ultra grand-angle'), 'ultrawide');
  assert.equal(lensKind('Téléobjectif arrière'), 'tele');
  assert.equal(lensKind('camera2 0, facing back'), '');
  assert.equal(lensKind('camera2 2, facing back'), '');
  assert.equal(lensKind(''), '');
});

test('Pixel in Chrome: one front, one rear, and a note saying why', () => {
  const cameras = [cam('b', 'camera2 0, facing back', 'environment'), cam('f', 'camera2 1, facing front', 'user')];
  assert.deepEqual(names(cameras), ['Front', 'Rear']);
  assert.equal(lensNote(orderCameras(cameras)), 'viewer.lensNoteOneRear');
});

test('iPhone Pro in Safari: named lenses, combined cameras left out', () => {
  const cameras = [
    cam('f', 'Front Camera', 'user'),
    cam('b', 'Back Camera', 'environment'),
    cam('t', 'Back Telephoto Camera', 'environment'),
    cam('d', 'Back Dual Wide Camera', 'environment'),
    cam('tr', 'Back Triple Camera', 'environment'),
    cam('u', 'Back Ultra Wide Camera', 'environment'),
  ];
  assert.deepEqual(names(cameras), ['Front', 'Ultra wide', 'Wide', 'Telephoto']);
  assert.deepEqual(orderCameras(cameras).map((c) => c.deviceId), ['f', 'u', 'b', 't']);
  assert.equal(lensNote(orderCameras(cameras)), null);
});

test('a combined camera stays when it is the only rear one', () => {
  const cameras = [cam('f', 'Front Camera', 'user'), cam('tr', 'Back Triple Camera', 'environment')];
  assert.deepEqual(names(cameras), ['Front', 'Multi-lens']);
});

test('Android with several unnamed rear lenses: numbered, with a note', () => {
  const cameras = [
    cam('0', 'camera2 0, facing back', 'environment'),
    cam('1', 'camera2 1, facing front', 'user'),
    cam('2', 'camera2 2, facing back', 'environment'),
    cam('3', 'camera2 3, facing front', 'user'),
  ];
  assert.deepEqual(names(cameras), ['Front 1', 'Front 2', 'Rear 1', 'Rear 2']);
  assert.equal(lensNote(orderCameras(cameras)), 'viewer.lensNoteUnnamed');
});

test('cameras that don’t say which way they face come last, numbered', () => {
  const cameras = [cam('a', 'USB Camera', ''), cam('b', 'Back Camera', 'environment'), cam('c', 'Other', '')];
  assert.deepEqual(names(cameras), ['Rear', 'Camera 1', 'Camera 2']);
});
