/**
 * Utilities for reading Claude's settings.json configuration
 * 
 * Handles reading Claude's settings.json file to respect user preferences
 * like includeCoAuthoredBy setting for commit message generation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';

export interface ClaudeSettings {
  includeCoAuthoredBy?: boolean;
  [key: string]: any;
}

/**
 * Get the path to Claude's settings.json file
 */
function getClaudeSettingsPath(): string {
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(claudeConfigDir, 'settings.json');
}

/**
 * Read Claude's settings.json file from the default location
 * 
 * @returns Claude settings object or null if file doesn't exist or can't be read
 */
export function readClaudeSettings(): ClaudeSettings | null {
  try {
    const settingsPath = getClaudeSettingsPath();
    
    if (!existsSync(settingsPath)) {
      logger.debug(`[ClaudeSettings] No Claude settings file found at ${settingsPath}`);
      return null;
    }
    
    const settingsContent = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(settingsContent) as ClaudeSettings;
    
    logger.debug(`[ClaudeSettings] Successfully read Claude settings from ${settingsPath}`);
    logger.debug(`[ClaudeSettings] includeCoAuthoredBy: ${settings.includeCoAuthoredBy}`);
    
    return settings;
  } catch (error) {
    logger.debug(`[ClaudeSettings] Error reading Claude settings: ${error}`);
    return null;
  }
}

/**
 * Check if Co-Authored-By lines should be included in commit messages
 * based on Claude's settings
 * 
 * @returns true if Co-Authored-By should be included, false otherwise
 */
export function shouldIncludeCoAuthoredBy(): boolean {
  const settings = readClaudeSettings();
  
  // If no settings file or includeCoAuthoredBy is not explicitly set,
  // default to true to maintain backward compatibility
  if (!settings || settings.includeCoAuthoredBy === undefined) {
    return true;
  }
  
  return settings.includeCoAuthoredBy;
}
function readSettingsFile(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch (error) {
    logger.debug(`[ClaudeSettings] Error reading ${path}: ${error}`);
    return null;
  }
}

/**
 * Read a boolean Claude Code setting the way Claude Code layers it: the
 * project's .claude/settings.local.json, then .claude/settings.json, then the
 * user's settings.json. Returns undefined when no layer sets a boolean.
 */
export function readClaudeBooleanSetting(key: string, projectDir: string): boolean | undefined {
  const layers = [
    join(projectDir, '.claude', 'settings.local.json'),
    join(projectDir, '.claude', 'settings.json'),
    getClaudeSettingsPath()
  ];
  for (const path of layers) {
    const value = readSettingsFile(path)?.[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}
