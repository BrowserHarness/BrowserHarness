import type { PageObservation } from "./protocol";

export interface TabEvidence {
  tab_id: number;
  url: string;
  title: string;
  visible_text: string;
}

const MAX_EVIDENCE_TEXT_PER_TAB = 2_500;
const MAX_TABS = 6;

export class TabEvidenceStore {
  private readonly observations = new Map<number, TabEvidence>();

  record(observation: PageObservation): void {
    this.observations.delete(observation.tab_id);
    this.observations.set(observation.tab_id, {
      tab_id: observation.tab_id,
      url: observation.url,
      title: observation.title,
      visible_text: observation.visible_text.slice(
        0,
        MAX_EVIDENCE_TEXT_PER_TAB
      )
    });

    while (this.observations.size > MAX_TABS) {
      const oldest = this.observations.keys().next().value;
      if (typeof oldest !== "number") break;
      this.observations.delete(oldest);
    }
  }

  list(): TabEvidence[] {
    return [...this.observations.values()];
  }
}
