import {
  SimulatedPrinter,
  type SimulationScenario,
} from './adapters/simulated';
import { StarUsbPrinter, starSupport } from './adapters/star-usb';
import type { TicketPrinter } from './port';

export function selectPrinter(
  mode: TicketPrinter['mode'],
  scenario: SimulationScenario,
): TicketPrinter {
  return mode === 'simulated'
    ? new SimulatedPrinter(scenario)
    : new StarUsbPrinter();
}

export function realPrinterSupport(): string | undefined {
  return starSupport(navigator.userAgent, location.protocol);
}
