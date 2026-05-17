const EMPTY_EVENT_PROPS_VALUE = Object.freeze({});
const ORDERED_LIST_EVENT_PROPS = Object.freeze({ ordered: true });
const UNORDERED_LIST_EVENT_PROPS = Object.freeze({ ordered: false });
const HEADER_TABLE_CELL_EVENT_PROPS = Object.freeze({ header: true });
const DATA_TABLE_CELL_EVENT_PROPS = Object.freeze({ header: false });
const SIGNATURE_3_EVENT_PROPS = Object.freeze({ tildes: 3 });
const SIGNATURE_4_EVENT_PROPS = Object.freeze({ tildes: 4 });
const SIGNATURE_5_EVENT_PROPS = Object.freeze({ tildes: 5 });
const HEADING_EVENT_PROPS: readonly Readonly<Record<string, unknown>>[] = [
  EMPTY_EVENT_PROPS_VALUE,
  Object.freeze({ level: 1 }),
  Object.freeze({ level: 2 }),
  Object.freeze({ level: 3 }),
  Object.freeze({ level: 4 }),
  Object.freeze({ level: 5 }),
  Object.freeze({ level: 6 }),
];

export const EMPTY_EVENT_PROPS = EMPTY_EVENT_PROPS_VALUE as Readonly<Record<string, unknown>>;

export function headingProps(level: number): Readonly<Record<string, unknown>> {
  return Number.isInteger(level) && level >= 1 && level < HEADING_EVENT_PROPS.length
    ? HEADING_EVENT_PROPS[level]!
    : Object.freeze({ level });
}

export function listProps(ordered: boolean): Readonly<Record<string, unknown>> {
  return ordered ? ORDERED_LIST_EVENT_PROPS : UNORDERED_LIST_EVENT_PROPS;
}

export function tableCellProps(header: boolean): Readonly<Record<string, unknown>> {
  return header ? HEADER_TABLE_CELL_EVENT_PROPS : DATA_TABLE_CELL_EVENT_PROPS;
}

export function signatureProps(tildes: 3 | 4 | 5): Readonly<Record<string, unknown>> {
  switch (tildes) {
    case 3:
      return SIGNATURE_3_EVENT_PROPS;
    case 4:
      return SIGNATURE_4_EVENT_PROPS;
    case 5:
      return SIGNATURE_5_EVENT_PROPS;
  }
}