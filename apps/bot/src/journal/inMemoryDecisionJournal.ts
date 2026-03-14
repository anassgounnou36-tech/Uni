import type { DecisionJournal, DecisionJournalEvent, JournalEventType } from './types.js';

export class InMemoryDecisionJournal implements DecisionJournal {
  private readonly events: DecisionJournalEvent[] = [];

  async append(event: DecisionJournalEvent): Promise<void> {
    this.events.push(event);
  }

  async byOrderHash(orderHash: `0x${string}`): Promise<DecisionJournalEvent[]> {
    return this.events.filter((event) => event.orderHash === orderHash);
  }

  async latest(limit: number): Promise<DecisionJournalEvent[]> {
    if (limit <= 0) {
      return [];
    }
    return this.events.slice(-limit);
  }

  async byType(type: JournalEventType): Promise<DecisionJournalEvent[]> {
    return this.events.filter((event) => event.type === type);
  }

  snapshot(): DecisionJournalEvent[] {
    return [...this.events];
  }
}
