declare module "pino-roll" {
  import type { DestinationStream } from "pino";
  interface PinoRollOptions {
    file: string;
    frequency?: "daily" | "hourly" | number;
    size?: string | number;
    dateFormat?: string;
    limit?: { count?: number };
    mkdir?: boolean;
  }
  export default function (opts: PinoRollOptions): Promise<DestinationStream>;
}
