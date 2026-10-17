/** A file, a file whose entry the engine cannot resolve, a directory by name, or a text item. */
export type FakeEntry = File | { withoutEntry: File } | { directory: string } | { text: string };

/**
 * Builds a `DataTransfer` stand-in whose items answer `getAsFile` and `webkitGetAsEntry`.
 * @param entries - What the transfer carries, in order.
 */
export function fakeDataTransfer(entries: ReadonlyArray<FakeEntry>): DataTransfer {
  const items = entries.map(fakeItem);
  return {
    types: items.some((item) => item.kind === 'file') ? ['Files'] : [],
    items,
    files: entries.filter((entry): entry is File => entry instanceof File),
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

/**
 * A drag event of `type` whose `dataTransfer` carries `entries`.
 * @param type - `dragenter`, `dragover`, `dragleave` or `drop`.
 * @param entries - What the drag carries.
 */
export function makeDragEvent(type: string, entries: ReadonlyArray<FakeEntry> = []): DragEvent {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(ev, 'dataTransfer', {
    value: fakeDataTransfer(entries),
    configurable: true,
  });
  return ev;
}

/**
 * A paste event whose `clipboardData` carries `entries`.
 * @param entries - What the clipboard holds.
 */
export function makePasteEvent(entries: ReadonlyArray<FakeEntry>): ClipboardEvent {
  const ev = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(ev, 'clipboardData', {
    value: fakeDataTransfer(entries),
    configurable: true,
  });
  return ev;
}

function fakeItem(entry: FakeEntry) {
  if (entry instanceof File) {
    return {
      kind: 'file',
      type: entry.type,
      getAsFile: () => entry,
      webkitGetAsEntry: () => ({ isDirectory: false, isFile: true, name: entry.name }),
    };
  }
  if ('withoutEntry' in entry) {
    return {
      kind: 'file',
      type: entry.withoutEntry.type,
      getAsFile: () => entry.withoutEntry,
      webkitGetAsEntry: () => null,
    };
  }
  if ('directory' in entry) {
    return {
      kind: 'file',
      type: '',
      getAsFile: () => new File([], entry.directory),
      webkitGetAsEntry: () => ({ isDirectory: true, isFile: false, name: entry.directory }),
    };
  }
  return {
    kind: 'string',
    type: 'text/plain',
    getAsFile: () => null,
    webkitGetAsEntry: () => null,
  };
}
