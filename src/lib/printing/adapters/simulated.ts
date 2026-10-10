import { parseTicket } from '../../tickets/ticket';
import { ticketText } from '../../tickets/format';
import type { OrderTicket } from '../../tickets/ticket';
import type { PrintAttemptResult, TicketPrinter } from '../port';

export type SimulationScenario = 'accepted' | 'failed' | 'outcome-unknown';
export class SimulatedPrinter implements TicketPrinter {
  readonly mode = 'simulated';
  readonly label = 'Simulated printer · no hardware';
  preview = '';
  constructor(
    private scenario: SimulationScenario = 'accepted',
    private delayMs = 350,
  ) {}

  async print(
    ticket: OrderTicket,
    options: { reprint: boolean },
  ): Promise<PrintAttemptResult> {
    this.preview = ticketText(parseTicket(ticket), options.reprint);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.scenario === 'accepted')
      return {
        status: 'accepted',
        simulated: true,
        message: 'Simulation accepted. Nothing was physically printed.',
      };
    return {
      status: this.scenario,
      simulated: true,
      code: this.scenario === 'failed' ? 'paper-out' : 'timeout',
      message:
        this.scenario === 'failed'
          ? 'Simulated paper-out failure. Nothing was physically printed.'
          : 'Simulated missing response. Nothing was physically printed; exercise the deliberate reprint flow.',
    };
  }
}
