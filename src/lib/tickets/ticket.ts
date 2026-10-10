export interface TicketItem {
  readonly name: string;
  readonly quantity: number;
  readonly modifiers: readonly string[];
  readonly instructions?: string;
}

export interface OrderTicket {
  readonly id: string;
  readonly createdAt: string;
  readonly reference: string;
  readonly items: readonly TicketItem[];
  readonly notes?: string;
}

function text(
  value: unknown,
  label: string,
  limit: number,
  optional = false,
): string | undefined {
  if (optional && (value === undefined || value === '')) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const clean = value.trim();
  if (optional && !clean) return undefined;
  if (!clean || clean.length > limit || /[\x00-\x1f\x7f]/.test(clean)) {
    throw new Error(`${label} must contain 1–${limit} printable characters.`);
  }
  return clean;
}

/** Validate stored/input data and return an immutable domain object. */
export function parseTicket(value: unknown): OrderTicket {
  if (!value || typeof value !== 'object') throw new Error('Invalid ticket.');
  const v = value as Record<string, unknown>;
  const id = text(v.id, 'Ticket ID', 100)!;
  const reference = text(v.reference, 'Order reference', 20)!;
  const createdAt = text(v.createdAt, 'Timestamp', 40)!;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) ||
    !Number.isFinite(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt
  ) {
    throw new Error('Invalid ticket timestamp.');
  }
  if (!Array.isArray(v.items) || v.items.length < 1 || v.items.length > 30) {
    throw new Error('A ticket needs 1–30 items.');
  }
  const items = v.items.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object')
      throw new Error('Invalid ticket item.');
    const item = raw as Record<string, unknown>;
    if (
      !Number.isInteger(item.quantity) ||
      Number(item.quantity) < 1 ||
      Number(item.quantity) > 99
    ) {
      throw new Error('Quantity must be an integer from 1 to 99.');
    }
    if (!Array.isArray(item.modifiers) || item.modifiers.length > 20) {
      throw new Error('Modifiers must be a list of at most 20 entries.');
    }
    return Object.freeze({
      name: text(item.name, 'Item name', 120)!,
      quantity: item.quantity as number,
      modifiers: Object.freeze(
        item.modifiers.map((m: unknown) => text(m, 'Modifier', 120)!),
      ),
      instructions: text(item.instructions, 'Instructions', 600, true),
    });
  });
  return Object.freeze({
    id,
    reference,
    createdAt,
    items: Object.freeze(items),
    notes: text(v.notes, 'Notes', 1200, true),
  });
}

export function sampleTicket(id: string, createdAt: string): OrderTicket {
  return parseTicket({
    id,
    createdAt,
    reference: '0042',
    items: [
      {
        name: 'Vanilla ice cream',
        quantity: 2,
        modifiers: ['Waffle cone', 'Rainbow sprinkles'],
        instructions: 'Sprinkles on one cone only.',
      },
      {
        name: 'Chocolate ice cream',
        quantity: 1,
        modifiers: ['Cup', 'No toppings'],
      },
    ],
    notes: 'Illustrative test order. Please hand to the preparation team.',
  });
}
