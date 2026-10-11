import {
  SimulatedPrinter,
  type SimulationScenario,
} from './adapters/simulated';
import { PassPrntPrinter, passPrntSupport } from './adapters/passprnt';
import type { TicketPrinter } from './port';
import { LinuxCupsPrinter } from './adapters/linux-cups';

export function selectPrinter(
  mode: TicketPrinter['mode'],
  scenario: SimulationScenario,
): TicketPrinter {
  if (mode === 'simulated') return new SimulatedPrinter(scenario);
  if (mode === 'linux-cups') return new LinuxCupsPrinter();
  return new PassPrntPrinter(() => location.href, realPrinterSupport);
}

export function realPrinterSupport(): string | undefined {
  return passPrntSupport(navigator.userAgent, location.protocol);
}
