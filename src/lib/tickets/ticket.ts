import { assertPrintable } from './format';

export const FLAVORS = [
  'Chocolate',
  'Vanilla',
  'Strawberry',
  'Chocolate Chip',
] as const;
export const CONTAINERS = ['Cup', 'Cake Cone', 'Sugar Cone'] as const;
export const TOPPINGS = [
  'Whipped cream',
  'Gummy Bears',
  'Caramel Sauce',
  'Chocolate Sauce',
  'Sliced Almonds',
  'Maraschino Cherries',
  'Rainbow Sprinkles',
  'Chocolate Sprinkles',
] as const;
export type Flavor = (typeof FLAVORS)[number];
export type Container = (typeof CONTAINERS)[number];
export type Topping = (typeof TOPPINGS)[number];
export const maxScoopsPerServing = 5;
export const maxServings = 30;
export interface FlavorCount {
  readonly flavor: Flavor;
  readonly count: number;
}
export interface Serving {
  readonly flavors: readonly FlavorCount[];
  readonly container: Container;
  readonly toppings: readonly Topping[];
}
export interface ServingEditor {
  readonly flavors: readonly FlavorCount[];
  readonly container: Container | '';
  readonly toppings: readonly Topping[];
}
export interface OrderTicket {
  readonly schema: 2;
  readonly id: string;
  readonly createdAt: string;
  readonly reference: string;
  readonly customerName?: string;
  readonly displayName: string;
  readonly servings: readonly Serving[];
}
const ADJ = [
  'Happy',
  'Sunny',
  'Jolly',
  'Cheery',
  'Lucky',
  'Cozy',
  'Breezy',
  'Bouncy',
  'Friendly',
  'Merry',
  'Peppy',
  'Snazzy',
  'Bubbly',
  'Chipper',
  'Dandy',
  'Dreamy',
  'Fancy',
  'Fluffy',
  'Frosty',
  'Giggly',
  'Gleeful',
  'Golden',
  'Groovy',
  'Jazzy',
  'Perky',
  'Plucky',
  'Rosy',
  'Silly',
  'Sparkly',
  'Spunky',
  'Zesty',
  'Zippy',
];
const NOUN = [
  'Sprinkle',
  'Waffle',
  'Cherry',
  'Scoop',
  'Sundae',
  'Cone',
  'Swirl',
  'Fudge',
  'Gumdrop',
  'Almond',
  'Caramel',
  'Gummy Bear',
  'Biscuit',
  'Brownie',
  'Cookie',
  'Cupcake',
  'Float',
  'Honeycomb',
  'Jellybean',
  'Lollipop',
  'Macaron',
  'Malt',
  'Marshmallow',
  'Meringue',
  'Milkshake',
  'Muffin',
  'Pancake',
  'Pretzel',
  'Pudding',
  'Snow Cone',
  'Toffee',
  'Truffle',
];
const controls = /[\p{Cc}\u2028\u2029]/u;

function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const clean = value.trim();
  if (!clean || Array.from(clean).length > limit || controls.test(clean))
    throw new Error(`${label} must contain 1–${limit} printable characters.`);
  return clean;
}
export function cleanCustomerName(value: unknown, trim = true): string {
  if (typeof value !== 'string') throw new Error('Name must be text.');
  const sanitized = value.replace(/[\p{Cc}\u2028\u2029]/gu, '');
  const clean = trim ? sanitized.trim() : sanitized;
  if (Array.from(clean).length > 80)
    throw new Error('Name must contain at most 80 printable characters.');
  return clean;
}
export function parseReference(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1
  )
    throw new Error('Order reference must be a positive safe integer.');
  return String(Number(value)).padStart(4, '0');
}
/** Derives the label from the random ticket ID, so it is unpredictable per order yet stable for that ticket. */
export function blankNameLabel(ticketId: string): string {
  if (typeof ticketId !== 'string' || !ticketId)
    throw new Error('Invalid label ticket ID.');
  // FNV-1a, then a Murmur3 finalizer so the power-of-two pick uses every bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < ticketId.length; i++)
    hash = Math.imul(hash ^ ticketId.charCodeAt(i), 0x01000193);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  const pick = ((hash ^ (hash >>> 16)) >>> 0) % (ADJ.length * NOUN.length);
  return `${ADJ[Math.floor(pick / NOUN.length)]} ${NOUN[pick % NOUN.length]}`;
}
const longest = (words: readonly string[]) =>
  words.reduce((a, b) => (b.length > a.length ? b : a));
/** The longest possible label; tests check no other label prints taller. */
export const widestBlankNameLabel = `${longest(ADJ)} ${longest(NOUN)}`;
export const blankNameLabels: readonly string[] = Object.freeze(
  ADJ.flatMap((adjective) => NOUN.map((noun) => `${adjective} ${noun}`)),
);
export function totalScoops(serving: Pick<ServingEditor, 'flavors'>): number {
  return serving.flavors.reduce((total, portion) => total + portion.count, 0);
}

/** Shared serving validation; only the editor may omit scoops or its container. */
export function parseServing(value: unknown, partial: true): ServingEditor;
export function parseServing(value: unknown, partial?: false): Serving;
export function parseServing(value: unknown, partial = false): ServingEditor {
  if (!value || typeof value !== 'object') throw new Error('Invalid serving.');
  const raw = value as Record<string, unknown>;
  if (
    !Array.isArray(raw.flavors) ||
    raw.flavors.length > FLAVORS.length ||
    (!partial && !raw.flavors.length)
  )
    throw new Error('Add at least one scoop; each serving needs 1–5 scoops.');
  const selected = Array.from(raw.flavors, (value: unknown) => {
    if (!value || typeof value !== 'object')
      throw new Error('Invalid flavor count.');
    const portion = value as FlavorCount;
    if (!FLAVORS.includes(portion.flavor)) throw new Error('Invalid flavor.');
    if (
      !Number.isInteger(portion.count) ||
      portion.count < 1 ||
      portion.count > maxScoopsPerServing
    )
      throw new Error('Scoop counts must be whole numbers from 1 to 5.');
    return Object.freeze({ flavor: portion.flavor, count: portion.count });
  });
  if (new Set(selected.map((p) => p.flavor)).size !== selected.length)
    throw new Error('Each flavor can appear only once per serving.');
  if (totalScoops({ flavors: selected }) > maxScoopsPerServing)
    throw new Error('A serving can contain at most 5 scoops.');
  if (
    !CONTAINERS.includes(raw.container as Container) &&
    !(partial && raw.container === '')
  )
    throw new Error('Choose a container.');
  if (
    !Array.isArray(raw.toppings) ||
    Array.from(raw.toppings).some((t) => !TOPPINGS.includes(t)) ||
    new Set(raw.toppings).size !== raw.toppings.length
  )
    throw new Error('Invalid toppings.');
  return Object.freeze({
    flavors: Object.freeze(
      FLAVORS.flatMap((flavor) => selected.filter((p) => p.flavor === flavor)),
    ),
    container: raw.container as Container | '',
    toppings: Object.freeze(
      TOPPINGS.filter((t) => (raw.toppings as unknown[]).includes(t)),
    ),
  });
}

/** Single ticket entry point for input and storage; resolves names once and freezes deeply. */
export function parseTicket(value: unknown): OrderTicket {
  if (!value || typeof value !== 'object') throw new Error('Invalid ticket.');
  const v = value as Record<string, unknown>;
  if (v.schema !== 2 || 'items' in v)
    throw new Error('Unsupported ticket schema.');
  const id = text(v.id, 'Ticket ID', 100);
  const reference = parseReference(v.reference);
  const createdAt = text(v.createdAt, 'Timestamp', 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) ||
    !Number.isFinite(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt
  )
    throw new Error('Invalid ticket timestamp.');
  if (
    !Array.isArray(v.servings) ||
    v.servings.length < 1 ||
    v.servings.length > maxServings
  )
    throw new Error('A ticket needs 1–30 servings.');
  const customerName =
    v.customerName === undefined
      ? undefined
      : cleanCustomerName(v.customerName) || undefined;
  const displayName =
    v.displayName === undefined
      ? (customerName ?? blankNameLabel(id))
      : text(v.displayName, 'Display name', 80);
  if (customerName && displayName !== customerName)
    throw new Error('Display name must match the customer name.');
  const ticket: OrderTicket = Object.freeze({
    schema: 2,
    id,
    createdAt,
    reference,
    customerName,
    displayName,
    servings: Object.freeze(Array.from(v.servings, (s) => parseServing(s))),
  });
  assertPrintable(ticket);
  return ticket;
}
export function sampleTicket(id: string, createdAt: string): OrderTicket {
  return parseTicket({
    schema: 2,
    id,
    createdAt,
    reference: '0043',
    customerName: 'Maria',
    servings: [
      {
        flavors: [
          { flavor: 'Chocolate Chip', count: 2 },
          { flavor: 'Strawberry', count: 1 },
        ],
        container: 'Sugar Cone',
        toppings: ['Whipped cream', 'Chocolate Sauce'],
      },
      {
        flavors: [{ flavor: 'Vanilla', count: 1 }],
        container: 'Cup',
        toppings: [],
      },
      {
        flavors: [
          { flavor: 'Chocolate', count: 1 },
          { flavor: 'Vanilla', count: 1 },
        ],
        container: 'Cake Cone',
        toppings: ['Gummy Bears'],
      },
    ],
  });
}
