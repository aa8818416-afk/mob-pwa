/**
 * Standby Wake Word Listener — Disabled / Cleaned
 */

export class StandbyWakeWordManager {
  public isSupported(): boolean {
    return false;
  }

  public isListening(): boolean {
    return false;
  }

  public startListening(_onStart: () => void): void {
    // Disabled
  }

  public stopListening(): void {
    // Disabled
  }
}

export const standbyWakeWordManager = new StandbyWakeWordManager();
