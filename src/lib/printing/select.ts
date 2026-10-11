import {
  SimulatedPrinter,
  type SimulationScenario,
} from './adapters/simulated';
import { PassPrntPrinter, passPrntSupport } from './adapters/passprnt';
import type { TicketPrinter } from './port';

export function selectPrinter(
  mode: TicketPrinter['mode'],
  scenario: SimulationScenario,
): TicketPrinter {
  return mode === 'simulated'
    ? new SimulatedPrinter(scenario)
    : new PassPrntPrinter(() => location.href, realPrinterSupport);
}

export function realPrinterSupport(): string | undefined {
  return passPrntSupport(navigator.userAgent, location.protocol);
}
