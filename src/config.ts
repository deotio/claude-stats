/**
 * Configuration management for claude-stats.
 * Stores user preferences in ~/.claude-stats/config.json.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface Config {
  costThresholds?: {
    day?: number;
    week?: number;
    month?: number;
  };
}

const CONFIG_DIR = path.join(os.homedir(), ".claude-stats");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function loadConfig(configPath?: string): Config {
  const filePath = configPath ?? CONFIG_FILE;
  try {
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data) as Config;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

export function saveConfig(config: Config, configPath?: string): void {
  const filePath = configPath ?? CONFIG_FILE;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function getCostThreshold(config: Config, period: string): number | undefined {
  return config.costThresholds?.[period as keyof NonNullable<Config["costThresholds"]>];
}
