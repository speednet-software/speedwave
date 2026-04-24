import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import { SkillsService, type Skill } from '../services/skills.service';

/**
 * Catalog of slash commands, skills, and agents available to the current
 * project. Data is wired to `SkillsService`, which returns the hardcoded
 * fallback until Unit 13 lands the live slash-discovery Tauri command.
 */
@Component({
  selector: 'app-skills-view',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './skills-view.component.html',
  host: {
    class: 'flex flex-1 flex-col overflow-hidden bg-[var(--bg)] text-[var(--ink)] min-h-screen',
  },
})
export class SkillsViewComponent implements OnInit {
  private readonly skills = inject(SkillsService);

  /** Current list of discovered skills. */
  protected readonly items = this.skills.discovered;

  /** Count of discovered entries, used in the header subtitle. */
  protected readonly total = computed(() => this.items().length);

  /** True while the list is empty (e.g. before first `refresh()`). */
  protected readonly empty = computed(() => this.items().length === 0);

  /** Loads the initial list from the service. */
  async ngOnInit(): Promise<void> {
    await this.skills.refresh();
  }

  /**
   * Returns the short badge label shown next to each entry.
   * Plugin-prefixed entries are tagged `plugin:<slug>`; everything else
   * uses the semantic source verbatim.
   * @param skill - the skill/command entry the badge is rendered for
   */
  protected badgeLabel(skill: Skill): string {
    return skill.plugin ? `plugin:${skill.plugin}` : skill.source;
  }

  /**
   * Tailwind color class for the badge, tied to semantic source.
   * @param skill - the skill/command entry the badge is rendered for
   */
  protected badgeClass(skill: Skill): string {
    if (skill.plugin) return 'text-[var(--violet)]';
    switch (skill.source) {
      case 'skill':
        return 'text-[var(--teal)]';
      case 'cmd':
      case 'built-in':
        return 'text-[var(--ink-dim)]';
      case 'agent':
        return 'text-[var(--amber)]';
      case 'fallback':
        return 'text-[var(--ink-mute)]';
      default:
        return 'text-[var(--ink-dim)]';
    }
  }
}
