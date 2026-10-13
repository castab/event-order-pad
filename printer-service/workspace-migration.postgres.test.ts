import { expect, it } from 'vitest';
import { Client } from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sampleTicket } from '../src/lib/tickets/ticket';
import { newDraft } from '../src/lib/tickets/order';

const url = process.env.TEST_DATABASE_URL!;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Use a separate *_test database.');

it.each(['editable', 'accepted', 'outcome-unknown'] as const)(
  'preserves the legacy %s workspace and all print history during migration',
  async (status) => {
    const client = new Client({ connectionString: url });
    const schema = 'migration_' + randomUUID().replaceAll('-', '');
    await client.connect();
    try {
      await client.query('CREATE SCHEMA ' + schema);
      await client.query('SET search_path TO ' + schema);
      for (const migration of [
        '20261013000000_order_events',
        '20261014000000_station_persistence',
      ])
        await client.query(
          await readFile(
            'prisma/migrations/' + migration + '/migration.sql',
            'utf8',
          ),
        );
      const ticket = sampleTicket('legacy-ticket', '2026-10-11T20:00:00.000Z');
      const result = {
        status,
        simulated: false,
        code: 'transport',
        message: 'Legacy outcome',
      };
      const attempt = {
        id: 'legacy-attempt',
        ticketId: ticket.id,
        mode: 'linux-cups',
        reprint: false,
        startedAt: ticket.createdAt,
        ...(status === 'editable'
          ? {}
          : { result, completedAt: ticket.createdAt }),
      };
      const draft = {
        ...newDraft(),
        name: 'Preserved',
        reference: '0044',
        ...(status === 'editable'
          ? {}
          : {
              reference: ticket.reference,
              submittedTicketId: ticket.id,
              servings: ticket.servings,
            }),
      };
      await client.query('INSERT INTO tickets VALUES ($1,$2)', [
        ticket.id,
        ticket,
      ]);
      await client.query('INSERT INTO print_attempts VALUES ($1,$2,$3)', [
        attempt.id,
        ticket.id,
        attempt,
      ]);
      if (status !== 'editable')
        await client.query(
          'INSERT INTO print_dispatches VALUES ($1,$2,$3,$4)',
          [
            attempt.id,
            { ticket, attemptId: attempt.id, reprint: false },
            result,
            ticket.createdAt,
          ],
        );
      await client.query('INSERT INTO station VALUES (1,7,44,$1,$2)', [
        draft,
        ticket.id,
      ]);
      await client.query(
        await readFile(
          'prisma/migrations/20261015000000_browser_workspaces/migration.sql',
          'utf8',
        ),
      );
      const workspace = (await client.query('SELECT * FROM workspaces'))
        .rows[0];
      expect(workspace.cookie_id).toBeNull();
      expect(workspace.revision).toBe(7);
      expect(workspace.latest_ticket_id).toBe(ticket.id);
      expect(workspace.draft).toEqual(
        status === 'editable'
          ? Object.fromEntries(
              Object.entries(draft).filter(([key]) => key !== 'reference'),
            )
          : draft,
      );
      expect(
        (await client.query('SELECT * FROM tickets')).rows[0],
      ).toMatchObject({ content: ticket, workspace_id: 'legacy' });
      expect(
        (await client.query('SELECT content FROM print_attempts')).rows[0]
          .content,
      ).toEqual(attempt);
      expect(
        (await client.query('SELECT reference_counter FROM station')).rows[0]
          .reference_counter,
      ).toBe('44');
      expect(
        (await client.query('SELECT COUNT(*) FROM print_dispatches')).rows[0]
          .count,
      ).toBe(status === 'editable' ? '0' : '1');
    } finally {
      await client.query('SET search_path TO public');
      await client.query('DROP SCHEMA ' + schema + ' CASCADE');
      await client.end();
    }
  },
);
