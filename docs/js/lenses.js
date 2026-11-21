// What each camera is, and what to call it. The camera phone works out each
// camera's direction and lens type; the viewer turns that list into names
// such as Front, Ultra wide, Wide or Telephoto.
//
// Only iPhones say which lens is which, in the camera's name ("Back Ultra
// Wide Camera"). Android browsers name cameras "camera2 0, facing back", so
// extra rear lenses there are just numbered. Pixels don't offer their ultra
// wide to browsers at all: it sits behind the main rear camera, and Chrome
// can't zoom out below 1×, which is how Android apps switch to it.

// Lens type from a camera's name: 'ultrawide', 'tele', 'multi' (an iPhone's
// combined Dual / Triple camera, which changes lens as it zooms) or '' for
// a plain or unknown camera. iPhones translate the names, so cover the
// common languages.
export function lensKind(label = '') {
  const l = label.toLowerCase();
  if (/dual|triple|double|doble|dreifach|duplo|tripla|双|雙|三|デュアル|トリプル|듀얼|트리플/.test(l)) return 'multi';
  if (/ultra[\s-]?wide|ultra[\s-]?grand|ultraweit|ultra[\s-]?gran|超广角|超廣角|超広角|초광각/.test(l)) return 'ultrawide';
  if (/t[eé]l[eé]|长焦|長焦|望远|望遠|망원/.test(l)) return 'tele';
  return '';
}

const FACING_RANK = { user: 0, environment: 1, '': 2 };
const KIND_RANK = { ultrawide: 0, '': 1, tele: 2, multi: 3 };

// Switching order: front cameras, then rear from widest to longest, then any
// we can't place. Takes [{ deviceId, facing, kind }]. A combined camera is
// dropped when the plain rear camera is there too, so the list reads like
// the phone's own camera app: Front, Ultra wide, Wide, Telephoto.
export function orderCameras(cameras) {
  const hasPlainRear = cameras.some((c) => c.facing === 'environment' && !c.kind);
  return cameras
    .filter((c) => !(hasPlainRear && c.facing === 'environment' && c.kind === 'multi'))
    .map((c, i) => ({ c, i }))
    .sort((a, b) => FACING_RANK[a.c.facing] - FACING_RANK[b.c.facing]
      || KIND_RANK[a.c.kind] - KIND_RANK[b.c.kind]
      || a.i - b.i) // otherwise keep the phone's own order
    .map(({ c }) => c);
}

// Translation keys for each name, singular and numbered.
const NAMES = {
  front: ['viewer.front', 'viewer.frontN'],
  rear: ['viewer.rear', 'viewer.rearN'],
  wide: ['viewer.wide', 'viewer.wideN'],
  ultrawide: ['viewer.ultraWide', 'viewer.ultraWideN'],
  tele: ['viewer.telephoto', 'viewer.telephotoN'],
  multi: ['viewer.multiLens', 'viewer.multiLensN'],
  other: ['viewer.otherCamera', 'viewer.otherCameraN'],
};

// Names for an ordered camera list, as [{ deviceId, key, vars }] to pass to
// setText. The main rear camera is "Wide" when the phone has named lenses
// beside it, otherwise "Rear". Numbered only when several share a name.
export function nameCameras(cameras) {
  const namedRear = cameras.some((c) => c.facing === 'environment' && c.kind && c.kind !== 'multi');
  const group = (c) => {
    if (c.facing === 'user') return 'front';
    if (c.facing === 'environment') return c.kind || (namedRear ? 'wide' : 'rear');
    return 'other';
  };
  const groups = cameras.map(group);
  const seen = {};
  return cameras.map((c, i) => {
    const g = groups[i];
    const count = groups.filter((x) => x === g).length;
    seen[g] = (seen[g] || 0) + 1;
    const [one, numbered] = NAMES[g];
    return count > 1
      ? { deviceId: c.deviceId, key: numbered, vars: { n: seen[g] } }
      : { deviceId: c.deviceId, key: one, vars: null };
  });
}

// A line under the camera choices when the list needs explaining, or null:
// only one rear camera (Pixels hide their ultra wide from browsers), or
// several rear ones the phone doesn't name.
export function lensNote(cameras) {
  const rear = cameras.filter((c) => c.facing === 'environment');
  if (rear.length <= 1) return 'viewer.lensNoteOneRear';
  if (rear.every((c) => !c.kind)) return 'viewer.lensNoteUnnamed';
  return null;
}
