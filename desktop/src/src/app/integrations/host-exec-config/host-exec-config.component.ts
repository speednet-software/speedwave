import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { open as openOsDialog } from '@tauri-apps/plugin-dialog';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { ModalOverlayComponent } from '../../shell/modal-overlay/modal-overlay.component';
import {
  HOST_EXEC_META_TOOLS,
  HOST_EXEC_PARAM_NAME_RE,
  HOST_EXEC_PRESETS,
  HOST_EXEC_RECIPE_NAME_RE,
  HOST_EXEC_RESERVED_ENV_KEYS,
  HOST_EXEC_SHELL_LAUNCHERS,
  type HostExecCommand,
  type HostExecStatus,
  argParamRefs,
  execBasenameLower,
  isBareParamArg,
  isContainerLifecycleRecipe,
  isStateChangingRecipe,
  joinArgLine,
  parseArgLine,
  renderRecipeCommand,
} from '../../models/host-exec';

/** Editable form state for the add/edit-recipe dialog. */
interface RecipeDraft {
  /** `true` when editing an existing recipe (then `originalName` is set); `false` when adding. */
  editing: boolean;
  /** The name the recipe had before editing — used to find/replace it. */
  originalName: string;
  /** Selected starter-template key (empty = custom / none). */
  presetKey: string;
  name: string;
  exec: string;
  /** Arguments as a single command-line string — parsed via `parseArgLine`. */
  argLine: string;
  cwdSub: string;
  params: { name: string; pattern: string; maxLen: string }[];
  env: { key: string; value: string }[];
}

/**
 * Host Exec integration card — gated toggle + danger modal + recipe editor (ADR-054).
 * Enabling is the consent: whitelisted recipes run without per-call prompts.
 */
@Component({
  selector: 'app-host-exec-config',
  imports: [CommonModule, ModalOverlayComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="mb-6" data-testid="host-exec-config">
      <h2 class="view-title view-title-section text-[var(--ink)]">Host Exec</h2>

      <div
        class="mt-3 overflow-hidden rounded border border-[var(--line)] bg-[var(--bg-1)]"
        data-testid="host-exec-card"
      >
        <!-- Header row: name + description + gated toggle -->
        <div class="flex items-center gap-3 px-4 py-3">
          <span class="mono text-[13px] text-[var(--ink)]" data-testid="host-exec-name"
            >host_exec</span
          >
          <span
            class="mono text-[11px] px-1.5 py-0.5 rounded"
            data-testid="host-exec-badge"
            [class.bg-amber-500/15]="enabled"
            [class.text-amber-300]="enabled"
            [class.bg-[var(--bg-2)]]="!enabled"
            [class.text-[var(--ink-mute)]]="!enabled"
            >{{ enabled ? 'enabled — host access' : 'disabled' }}</span
          >
          <span class="mono ml-1 text-[11px] text-[var(--ink-mute)]"
            >run project commands on this machine</span
          >
          <button
            type="button"
            class="toggle ml-auto"
            [class.on]="enabled"
            [attr.aria-pressed]="enabled"
            [attr.aria-label]="(enabled ? 'Disable ' : 'Enable ') + 'host_exec'"
            data-testid="host-exec-toggle"
            [disabled]="busy"
            (click)="onToggleClick()"
          ></button>
        </div>
        <p
          class="px-4 pb-3 text-[12px] leading-relaxed text-[var(--ink-dim)]"
          data-testid="host-exec-description"
        >
          Host Exec lets Claude run a whitelist of your project's commands (build, test, lint,
          <span class="mono">docker compose</span>, …) on this computer, in this project's folder —
          closing the gap where Claude, running in a container, can't drive your toolchain. It is a
          deliberate, scoped weakening of Speedwave's isolation: opt-in per project, the whitelist
          starts empty, the config lives only in your user config (never the repo). Enabling it is
          the consent — Claude then runs whitelisted recipes without further prompting (the audit
          log records every run), so only whitelist commands you're OK with Claude running anytime.
        </p>

        @if (error) {
          <div
            class="mono mx-4 mb-3 rounded border border-red-500/30 bg-red-500/5 p-2 text-[11.5px] text-red-300"
            data-testid="host-exec-error"
            role="alert"
          >
            {{ error }}
          </div>
        }

        @if (enabled) {
          <div class="border-t border-[var(--line)] px-4 py-3" data-testid="host-exec-recipes">
            <div class="mb-2 flex items-center gap-2">
              <span class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                >whitelisted commands</span
              >
              <button
                type="button"
                class="mono ml-auto rounded border border-[var(--accent-dim)] px-2 py-0.5 text-[11px] text-[var(--accent)] hover:bg-[var(--accent-soft)]"
                data-testid="host-exec-add"
                (click)="openAdd()"
              >
                + add command
              </button>
            </div>

            @if (commands.length === 0) {
              <div
                class="mono rounded border border-[var(--line)] bg-[var(--bg-2)] px-3 py-2 text-[11.5px] text-[var(--ink-mute)]"
                data-testid="host-exec-empty"
              >
                No commands yet — Claude can run nothing. Add one (e.g.
                <span class="text-[var(--ink-dim)]">./gradlew test</span>) to get started.
              </div>
            } @else {
              <div class="overflow-hidden rounded border border-[var(--line)]">
                <table class="mono w-full border-collapse text-[12px]">
                  <thead>
                    <tr
                      class="bg-[var(--bg-2)] text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                    >
                      <th class="px-3 py-1.5 text-left font-medium">name</th>
                      <th class="px-3 py-1.5 text-left font-medium">command</th>
                      <th class="px-3 py-1.5 text-left font-medium">dir</th>
                      <th class="px-3 py-1.5 text-right font-medium">actions</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-[var(--line)]">
                    @for (cmd of commands; track cmd.name) {
                      <tr [attr.data-testid]="'host-exec-recipe-' + cmd.name">
                        <td
                          class="px-3 py-1.5 text-[var(--ink)]"
                          data-testid="host-exec-recipe-name"
                        >
                          {{ cmd.name }}
                        </td>
                        <td
                          class="px-3 py-1.5 text-[var(--ink-dim)]"
                          data-testid="host-exec-recipe-cmd"
                        >
                          {{ renderCmd(cmd) }}
                        </td>
                        <td class="px-3 py-1.5 text-[var(--ink-mute)]">
                          {{ cmd.cwdSub || '.' }}
                        </td>
                        <td class="px-3 py-1.5 text-right">
                          <button
                            type="button"
                            class="text-[var(--accent)] hover:underline"
                            [attr.data-testid]="'host-exec-edit-' + cmd.name"
                            (click)="openEdit(cmd)"
                          >
                            edit
                          </button>
                          <button
                            type="button"
                            class="ml-3 text-red-400 hover:underline"
                            [attr.data-testid]="'host-exec-delete-' + cmd.name"
                            (click)="deleteRecipe(cmd)"
                          >
                            remove
                          </button>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }

            <div class="mt-3 flex items-center gap-2">
              <button
                type="button"
                class="mono rounded border border-[var(--accent-dim)] px-3 py-1 text-[12px] text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:opacity-50"
                data-testid="host-exec-save"
                [disabled]="busy || !dirty"
                (click)="save()"
              >
                {{ busy ? 'saving…' : dirty ? 'save changes' : 'saved' }}
              </button>
              @if (dirty) {
                <button
                  type="button"
                  class="mono rounded border border-[var(--line)] px-3 py-1 text-[12px] text-[var(--ink-dim)] hover:text-[var(--ink)]"
                  data-testid="host-exec-revert"
                  [disabled]="busy"
                  (click)="revert()"
                >
                  discard
                </button>
              }
              <span class="mono text-[10.5px] text-[var(--ink-mute)]">
                Tip: don't put secrets in a recipe's env — use a
                <span class="text-[var(--ink-dim)]">.env</span> in the repo.
              </span>
            </div>
          </div>
        }
      </div>
    </section>

    <!-- Danger modal shown when enabling host_exec for this project. -->
    <app-modal-overlay
      [open]="showEnableDanger"
      kicker="⚠ this weakens Speedwave's isolation"
      kickerColor="red"
      borderColor="red"
      modalTitle="Enable Host Exec for this project?"
      [body]="enableDangerBody"
      [code]="enableDangerExamples"
      [note]="enableDangerNote"
      primaryLabel="I understand — enable Host Exec"
      secondaryLabel="cancel"
      testId="host-exec-enable-danger"
      (primary)="confirmEnable()"
      (secondary)="cancelEnable()"
      (closed)="cancelEnable()"
    />

    <!-- Add / edit recipe dialog. -->
    @if (draft) {
      <div
        class="fixed inset-0 z-[1250] flex items-center justify-center bg-black/75 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="draft.editing ? 'Edit command' : 'Add command'"
        data-testid="host-exec-dialog"
        (click)="closeDialog()"
        (keydown.escape)="closeDialog()"
        tabindex="-1"
      >
        <div
          class="max-h-[88vh] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto rounded border border-[var(--line-strong)] bg-[var(--bg-1)] p-5"
          role="document"
          (click)="$event.stopPropagation()"
          (keydown)="$event.stopPropagation()"
        >
          <div class="mono text-[11px] uppercase tracking-widest text-[var(--accent)]">
            {{ draft.editing ? 'edit command' : 'add command' }}
          </div>
          <h3
            class="view-title view-title-section mt-1 text-[var(--ink)]"
            data-testid="host-exec-dialog-title"
          >
            {{ draft.editing ? 'Edit ' + draft.originalName : 'Add a command to the whitelist' }}
          </h3>

          <!-- preset starter -->
          <label
            class="mono mt-4 mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
            for="host-exec-d-preset"
            >start from a template
            <span class="text-[var(--ink-dim)]"
              >(fills the fields below — you edit everything)</span
            ></label
          >
          <select
            id="host-exec-d-preset"
            data-testid="host-exec-d-preset"
            class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)]"
            [value]="draft.presetKey"
            (change)="applyPreset(inputVal($event))"
          >
            <option value="">— custom —</option>
            @for (p of presets; track p.key) {
              <option [value]="p.key">{{ p.label }}</option>
            }
          </select>

          <!-- name -->
          <label
            class="mono mt-3 mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
            for="host-exec-d-name"
            >name (snake_case)</label
          >
          <input
            id="host-exec-d-name"
            type="text"
            [value]="draft.name"
            (input)="draft.name = inputVal($event)"
            placeholder="gradle_test"
            data-testid="host-exec-d-name"
            class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)]"
          />
          <p class="mono mt-0.5 text-[10px] text-[var(--ink-mute)]">
            Claude calls it as
            <span class="text-[var(--ink-dim)]">host_exec.{{ camelName(draft.name) }}()</span>
          </p>

          <!-- exec -->
          <label
            class="mono mt-3 mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
            for="host-exec-d-exec"
            >executable</label
          >
          <div class="flex items-stretch gap-2">
            <input
              id="host-exec-d-exec"
              type="text"
              [value]="draft.exec"
              (input)="draft.exec = inputVal($event); recomputeExecHint()"
              placeholder="./gradlew  (or  docker  /  /opt/homebrew/bin/gradle)"
              data-testid="host-exec-d-exec"
              class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)]"
            />
            <button
              type="button"
              class="mono shrink-0 rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg)] disabled:opacity-50"
              data-testid="host-exec-d-find"
              [disabled]="execResolving"
              (click)="findExecOnPath()"
              title="Look up this command name on the recovered host PATH"
            >
              {{ execResolving ? '…' : 'find on PATH' }}
            </button>
            <button
              type="button"
              class="mono shrink-0 rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg)]"
              data-testid="host-exec-d-browse"
              (click)="browseExec()"
            >
              browse…
            </button>
          </div>
          @if (execHint) {
            <p
              class="mono mt-0.5 text-[10px]"
              [class.text-amber-400]="execHintWarn"
              [class.text-[var(--ink-mute)]]="!execHintWarn"
              data-testid="host-exec-d-exec-hint"
            >
              {{ execHint }}
            </p>
          }

          <!-- args — one command-line string -->
          <label
            class="mono mt-3 mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
            for="host-exec-d-argline"
            >arguments —
            <span class="text-[var(--ink-dim)]">type them as on a command line</span></label
          >
          <input
            id="host-exec-d-argline"
            type="text"
            [value]="draft.argLine"
            (input)="draft.argLine = inputVal($event)"
            data-testid="host-exec-d-argline"
            placeholder='ps -a    /    test --tests={class}    /    --filter "name=foo bar"'
            class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)]"
          />
          <p class="mono mt-0.5 text-[10px] text-[var(--ink-mute)]">
            Split on spaces (use <span class="text-[var(--ink-dim)]">&quot;quotes&quot;</span> for
            an argument that contains a space). This is
            <span class="text-[var(--ink-dim)]">not a shell</span> —
            <span class="text-[var(--ink-dim)]">$VAR</span>,
            <span class="text-[var(--ink-dim)]">&amp;&amp;</span>,
            <span class="text-[var(--ink-dim)]">|</span>,
            <span class="text-[var(--ink-dim)]">;</span> and globs are passed through literally,
            never interpreted. Use
            <span class="text-[var(--ink-dim)]">{{ '{' }}name{{ '}' }}</span> for a value Claude
            supplies.
          </p>
          <!-- token-chip preview: exactly what will run -->
          @if (draftArgParseError(); as perr) {
            <p
              class="mono mt-2 rounded border border-red-500/30 bg-red-500/5 px-2 py-1 text-[10.5px] text-red-300"
              data-testid="host-exec-d-argline-error"
            >
              {{ perr }}
            </p>
          } @else {
            <div
              class="mono mt-2 flex flex-wrap items-center gap-1.5 rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1.5 text-[11px] text-[var(--ink-mute)]"
              data-testid="host-exec-d-argv-preview"
            >
              <span class="text-[var(--ink-mute)]">→ runs:</span>
              <span
                class="rounded border border-teal-500/30 bg-[var(--bg-3)] px-1.5 py-0.5 text-teal-300"
                >{{ draftExecBasename() }}</span
              >
              @if (draftArgv().length === 0) {
                <span
                  class="rounded border border-red-500/30 border-dashed bg-[var(--bg-3)] px-1.5 py-0.5 text-red-300"
                  >(no args)</span
                >
              }
              @for (a of draftArgv(); track $index) {
                <span
                  class="rounded border bg-[var(--bg-3)] px-1.5 py-0.5"
                  [class.border-amber-500/30]="argHasToken(a)"
                  [class.text-amber-300]="argHasToken(a)"
                  [class.border-red-500/30]="a === ''"
                  [class.text-red-300]="a === ''"
                  [class.border-[var(--line-strong)]]="!argHasToken(a) && a !== ''"
                  [class.text-[var(--ink-dim)]]="!argHasToken(a) && a !== ''"
                  >{{ chipLabel(a) }}</span
                >
              }
            </div>
          }

          <!-- params -->
          <div
            class="mono mt-3 mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
          >
            parameters Claude may supply (name · regex · max length)
          </div>
          @if (draft.params.length === 0) {
            <p
              class="mono text-[10.5px] text-[var(--ink-mute)]"
              data-testid="host-exec-d-params-empty"
            >
              None — the command runs exactly as written.
            </p>
          }
          @for (p of draft.params; track $index; let i = $index) {
            <div
              class="mb-1 flex items-stretch gap-2"
              [attr.data-testid]="'host-exec-d-param-' + i"
            >
              <input
                type="text"
                [value]="p.name"
                (input)="draft.params[i].name = inputVal($event)"
                placeholder="class"
                [attr.data-testid]="'host-exec-d-param-name-' + i"
                class="mono w-[28%] rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)]"
              />
              <input
                type="text"
                [value]="p.pattern"
                (input)="draft.params[i].pattern = inputVal($event)"
                placeholder="^[A-Za-z0-9_.]+$"
                [attr.data-testid]="'host-exec-d-param-pattern-' + i"
                class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)]"
              />
              <input
                type="text"
                inputmode="numeric"
                [value]="p.maxLen"
                (input)="draft.params[i].maxLen = inputVal($event)"
                placeholder="200"
                [attr.data-testid]="'host-exec-d-param-maxlen-' + i"
                class="mono w-[18%] rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)]"
              />
              <button
                type="button"
                class="mono shrink-0 rounded border border-[var(--line)] px-2 text-[11px] text-[var(--ink-mute)] hover:text-red-400"
                [attr.data-testid]="'host-exec-d-param-rm-' + i"
                (click)="removeParam(i)"
                aria-label="remove parameter"
              >
                ×
              </button>
            </div>
          }
          <button
            type="button"
            class="mono rounded border border-[var(--line)] px-2 py-0.5 text-[11px] text-[var(--ink-dim)] hover:text-[var(--ink)]"
            data-testid="host-exec-d-param-add"
            (click)="addParam()"
          >
            + parameter
          </button>

          <!-- cwdSub -->
          <label
            class="mono mt-3 mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
            for="host-exec-d-cwd"
            >subdirectory to run in (optional — for monorepos)</label
          >
          <input
            id="host-exec-d-cwd"
            type="text"
            [value]="draft.cwdSub"
            (input)="draft.cwdSub = inputVal($event)"
            placeholder="(project root)  e.g.  services/api"
            data-testid="host-exec-d-cwd"
            class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)]"
          />

          <!-- env -->
          <div
            class="mono mt-3 mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
          >
            environment variables (literals only — no secrets)
          </div>
          @for (e of draft.env; track $index; let i = $index) {
            <div class="mb-1 flex items-stretch gap-2" [attr.data-testid]="'host-exec-d-env-' + i">
              <input
                type="text"
                [value]="e.key"
                (input)="draft.env[i].key = inputVal($event)"
                placeholder="CI"
                [attr.data-testid]="'host-exec-d-env-key-' + i"
                class="mono w-[34%] rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)]"
              />
              <input
                type="text"
                [value]="e.value"
                (input)="draft.env[i].value = inputVal($event)"
                placeholder="true"
                [attr.data-testid]="'host-exec-d-env-value-' + i"
                class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)]"
              />
              <button
                type="button"
                class="mono shrink-0 rounded border border-[var(--line)] px-2 text-[11px] text-[var(--ink-mute)] hover:text-red-400"
                [attr.data-testid]="'host-exec-d-env-rm-' + i"
                (click)="removeEnv(i)"
                aria-label="remove env var"
              >
                ×
              </button>
            </div>
          }
          <button
            type="button"
            class="mono rounded border border-[var(--line)] px-2 py-0.5 text-[11px] text-[var(--ink-dim)] hover:text-[var(--ink)]"
            data-testid="host-exec-d-env-add"
            (click)="addEnv()"
          >
            + env var
          </button>

          <!-- container-lifecycle / state-changing warning -->
          @if (draftIsContainerLifecycle()) {
            <p
              class="mono mt-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[10.5px] text-amber-300"
              data-testid="host-exec-d-lifecycle-warn"
              role="status"
            >
              ⚠ this can mount arbitrary host paths into a privileged container — effectively host
              root, from a <span class="text-amber-200">docker-compose.yml</span> Claude can edit.
              Only add it if you trust this repo. There is no per-run prompt.
            </p>
          } @else if (draftIsStateChanging()) {
            <p
              class="mono mt-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[10.5px] text-amber-300"
              data-testid="host-exec-d-statechanging-warn"
              role="status"
            >
              ⚠ this command looks like it changes state (a database client, a migration). Claude
              can run it without a prompt once host_exec is enabled — only add it if that's OK.
            </p>
          }

          @if (draftError) {
            <div
              class="mono mt-3 rounded border border-red-500/30 bg-red-500/5 p-2 text-[11.5px] text-red-300"
              data-testid="host-exec-d-error"
              role="alert"
            >
              {{ draftError }}
            </div>
          }

          <div class="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              class="mono rounded border border-[var(--line)] px-3 py-1 text-[12px] text-[var(--ink-dim)] hover:text-[var(--ink)]"
              data-testid="host-exec-d-cancel"
              (click)="closeDialog()"
            >
              cancel
            </button>
            <button
              type="button"
              class="mono rounded border border-[var(--accent-dim)] px-3 py-1 text-[12px] text-[var(--accent)] hover:bg-[var(--accent-soft)]"
              data-testid="host-exec-d-save"
              (click)="commitDraft()"
            >
              {{ draft.editing ? 'update command' : 'add command' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class HostExecConfigComponent implements OnInit, OnDestroy {
  // ---- state -------------------------------------------------------------
  /**
   * The built-in recipe templates for the dialog's "start from a template"
   * dropdown. A getter (not a field initializer) so the value is resolved on
   * first access — sidesteps any module-init ordering quirk under the test
   * bundler that left a field initializer reading `undefined`.
   */
  get presets(): typeof HOST_EXEC_PRESETS {
    return HOST_EXEC_PRESETS;
  }
  /** Whether host_exec is enabled for the active project. */
  enabled = false;
  /** The persisted whitelist (last loaded/saved). */
  private persisted: HostExecCommand[] = [];
  /** The working copy edited in the UI; saved via `host_exec_save_settings`. */
  commands: HostExecCommand[] = [];
  /** Error banner text, empty if none. */
  error = '';
  /** True while a Tauri call is in flight (disables the toggle / save). */
  busy = false;

  /** True when `commands` differs from `persisted`. */
  get dirty(): boolean {
    return JSON.stringify(this.commands) !== JSON.stringify(this.persisted);
  }

  // ---- danger modal ------------------------------------------------------
  /** True while the enable-danger modal is open. */
  showEnableDanger = false;

  readonly enableDangerBody =
    "Host Exec lets Claude run the commands you list, on this computer, in this project's folder. " +
    'Those commands execute code from this repository — and because Claude can also edit this repo, ' +
    'a prompt-injected Claude could write a malicious build script and then run it. This is a ' +
    "deliberate weakening of Speedwave's container isolation. Enabling it is the consent: there is " +
    'no per-command prompt — once on, Claude runs any whitelisted command anytime (the audit log ' +
    "records every run). Only enable it for repositories you trust, only whitelist commands you're " +
    "OK with Claude running unattended, and never put secrets in a command's env.";
  readonly enableDangerExamples =
    './gradlew test          → runs build.gradle\n' +
    'npm run test            → runs code in node_modules\n' +
    'docker compose up       → runs the images in docker-compose.yml';
  readonly enableDangerNote =
    'Disable it any time. The whitelist starts empty — Claude can run nothing until you add a command.';

  // ---- add/edit dialog ---------------------------------------------------
  /** The recipe-draft form state, or `null` when the dialog is closed. */
  draft: RecipeDraft | null = null;
  /** Validation error shown inside the dialog, empty if none. */
  draftError = '';
  /** Inline hint under the `exec` field (absolute-path note / shell-launcher warning). */
  execHint = '';
  /** True when `execHint` is a warning (amber) rather than a neutral note. */
  execHintWarn = false;
  /** True while `host_exec_resolve_executable` is in flight. */
  execResolving = false;

  // ---- wiring ------------------------------------------------------------
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);
  private cdr = inject(ChangeDetectorRef);
  private unsubProjectSettled: (() => void) | null = null;
  /** The project this card last loaded for. */
  private project: string | null = null;

  /** Loads status, reloads on project change. */
  async ngOnInit(): Promise<void> {
    this.project = this.projectState.activeProject;
    await this.load();
    this.unsubProjectSettled = this.projectState.onProjectSettled(async () => {
      this.project = this.projectState.activeProject;
      await this.load();
    });
  }

  /** Tears down listeners. */
  ngOnDestroy(): void {
    this.unsubProjectSettled?.();
    this.unsubProjectSettled = null;
  }

  /** Fetches `{ enabled, commands }` for the active project. */
  async load(): Promise<void> {
    if (!this.project) return;
    this.error = '';
    try {
      const status = await this.tauri.invoke<HostExecStatus>('get_host_exec', {
        project: this.project,
      });
      this.enabled = status.enabled;
      this.persisted = structuredClone(status.commands);
      this.commands = structuredClone(status.commands);
    } catch (e: unknown) {
      this.error = this.errMsg(e);
    }
    this.cdr.markForCheck();
  }

  // ---- toggle / danger modal --------------------------------------------

  /** Toggle clicked: enabling pops the danger modal first; disabling is direct. */
  onToggleClick(): void {
    if (this.busy) return;
    if (this.enabled) {
      void this.setEnabled(false);
    } else {
      this.showEnableDanger = true;
      this.cdr.markForCheck();
    }
  }

  /** User confirmed the danger modal — enable host_exec. */
  confirmEnable(): void {
    this.showEnableDanger = false;
    void this.setEnabled(true);
  }

  /** User cancelled the danger modal — leave host_exec disabled. */
  cancelEnable(): void {
    this.showEnableDanger = false;
    this.cdr.markForCheck();
  }

  private async setEnabled(next: boolean): Promise<void> {
    if (!this.project) return;
    this.busy = true;
    this.error = '';
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke('set_host_exec_enabled', { project: this.project, enabled: next });
      this.enabled = next;
      // The backend recreates the project's containers if running; reflect it.
      this.projectState.requestRestart();
      // Re-pull the whitelist (unchanged, but keeps `persisted` authoritative).
      await this.load();
    } catch (e: unknown) {
      this.error = this.errMsg(e);
    }
    this.busy = false;
    this.cdr.markForCheck();
  }

  // ---- recipe list -------------------------------------------------------

  /**
   * Renders a recipe's `exec args` for the table.
   * @param cmd - The recipe to render.
   */
  renderCmd(cmd: HostExecCommand): string {
    return renderRecipeCommand(cmd);
  }

  /**
   * Removes a recipe from the working copy (not persisted until `save`).
   * @param cmd - The recipe to remove.
   */
  deleteRecipe(cmd: HostExecCommand): void {
    this.commands = this.commands.filter((c) => c.name !== cmd.name);
    this.cdr.markForCheck();
  }

  /** Discards unsaved edits, restoring the persisted whitelist. */
  revert(): void {
    this.commands = structuredClone(this.persisted);
    this.cdr.markForCheck();
  }

  /**
   * Persists the working copy via `host_exec_save_settings` (the backend
   * re-validates, writes the worker snapshot, respawns the worker, recreates
   * the hub container if running).
   */
  async save(): Promise<void> {
    if (!this.project || this.busy || !this.dirty) return;
    // Client-side pre-validation (mirror of the backend) — fail fast with a
    // readable message instead of round-tripping for a 500-ish string.
    const localErr = this.validateAll(this.commands);
    if (localErr) {
      this.error = localErr;
      this.cdr.markForCheck();
      return;
    }
    this.busy = true;
    this.error = '';
    this.cdr.markForCheck();
    try {
      await this.tauri.invoke('host_exec_save_settings', {
        project: this.project,
        commands: this.commands,
      });
      this.persisted = structuredClone(this.commands);
      this.projectState.requestRestart();
    } catch (e: unknown) {
      this.error = this.errMsg(e);
    }
    this.busy = false;
    this.cdr.markForCheck();
  }

  // ---- add / edit dialog -------------------------------------------------

  /** Opens the dialog with a blank draft (add mode). */
  openAdd(): void {
    this.draft = {
      editing: false,
      originalName: '',
      presetKey: '',
      name: '',
      exec: '',
      argLine: '',
      cwdSub: '',
      params: [],
      env: [],
    };
    this.draftError = '';
    this.recomputeExecHint();
    this.cdr.markForCheck();
  }

  /**
   * Opens the dialog populated from an existing recipe (edit mode).
   * @param cmd - The recipe to edit.
   */
  openEdit(cmd: HostExecCommand): void {
    this.draft = {
      editing: true,
      originalName: cmd.name,
      presetKey: '',
      name: cmd.name,
      exec: cmd.exec,
      argLine: joinArgLine(cmd.args),
      cwdSub: cmd.cwdSub ?? '',
      params: (cmd.params ?? []).map((p) => ({
        name: p.name,
        pattern: p.pattern,
        maxLen: p.maxLen != null ? String(p.maxLen) : '',
      })),
      env: Object.entries(cmd.env ?? {}).map(([key, value]) => ({ key, value })),
    };
    this.draftError = '';
    this.recomputeExecHint();
    this.cdr.markForCheck();
  }

  /**
   * Apply a starter template — fills name/exec/argLine/params (the user can
   * then edit anything). `''` (custom) leaves the draft untouched.
   * @param key - The preset key (`<option value>`).
   */
  applyPreset(key: string): void {
    if (!this.draft) return;
    this.draft.presetKey = key;
    const p = HOST_EXEC_PRESETS.find((x) => x.key === key);
    if (!p) {
      this.cdr.markForCheck();
      return;
    }
    this.draft.name = p.name;
    this.draft.exec = p.exec;
    this.draft.argLine = p.argLine;
    this.draft.params = p.params.map((x) => ({
      name: x.name,
      pattern: x.pattern,
      maxLen: x.maxLen != null ? String(x.maxLen) : '',
    }));
    this.execHint = p.execHint;
    this.execHintWarn = false;
    this.draftError = '';
    this.cdr.markForCheck();
  }

  /** Closes the dialog discarding the draft. */
  closeDialog(): void {
    this.draft = null;
    this.draftError = '';
    this.cdr.markForCheck();
  }

  /** Parsed argv from the draft's command-line string (`[]` on a parse error). */
  private draftArgvOrEmpty(): string[] {
    if (!this.draft) return [];
    const r = parseArgLine(this.draft.argLine);
    return 'error' in r ? [] : r.args;
  }
  /** The argv list for the preview chips. */
  draftArgv(): string[] {
    return this.draftArgvOrEmpty();
  }
  /** A parse error for the argument line, or empty when it parses. */
  draftArgParseError(): string {
    if (!this.draft) return '';
    const r = parseArgLine(this.draft.argLine);
    return 'error' in r ? r.error : '';
  }
  /** The executable basename for the preview chip (`exec` placeholder if empty). */
  draftExecBasename(): string {
    const e = this.draft?.exec.trim() ?? '';
    if (!e) return 'exec';
    return e.split(/[/\\]/).pop() || e;
  }
  /**
   * True if an argv element carries a `{name}` parameter token (amber chip).
   * @param arg - One parsed argv element.
   */
  argHasToken(arg: string): boolean {
    return argParamRefs(arg).length > 0;
  }
  /**
   * Label for an argv chip — quotes a token with a space, marks the empty one.
   * @param arg - One parsed argv element.
   */
  chipLabel(arg: string): string {
    if (arg === '') return '""(empty)';
    return /\s/.test(arg) ? `"${arg}"` : arg;
  }

  /** Appends a blank parameter row to the draft. */
  addParam(): void {
    this.draft?.params.push({ name: '', pattern: '', maxLen: '' });
    this.cdr.markForCheck();
  }
  /**
   * Removes the parameter row at index `i` from the draft.
   * @param i - The parameter row index.
   */
  removeParam(i: number): void {
    this.draft?.params.splice(i, 1);
    this.cdr.markForCheck();
  }
  /** Appends a blank environment-variable row to the draft. */
  addEnv(): void {
    this.draft?.env.push({ key: '', value: '' });
    this.cdr.markForCheck();
  }
  /**
   * Removes the environment-variable row at index `i` from the draft.
   * @param i - The env-var row index.
   */
  removeEnv(i: number): void {
    this.draft?.env.splice(i, 1);
    this.cdr.markForCheck();
  }

  /**
   * Reads the `value` off a DOM input/select event.
   * @param event - The `input`/`change` event from a form control.
   */
  inputVal(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  /**
   * `host_exec.<camelCase(name)>` preview for the dialog.
   * @param name - The snake_case recipe name being typed.
   */
  camelName(name: string): string {
    return name.replace(/_([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase()) || 'recipe';
  }

  /** Recomputes the inline hint under the `exec` field. */
  recomputeExecHint(): void {
    const exec = this.draft?.exec.trim() ?? '';
    this.execHint = '';
    this.execHintWarn = false;
    if (!exec) return;
    const base = execBasenameLower(exec);
    if (HOST_EXEC_SHELL_LAUNCHERS.includes(base)) {
      this.execHint = `"${base}" is a shell / eval launcher — Host Exec won't allow it (it would let Claude run anything). Point at the actual tool (e.g. ./gradlew, npm, docker).`;
      this.execHintWarn = true;
      return;
    }
    if (exec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(exec)) {
      this.execHint = 'This is an absolute executable path — make sure it is the one you mean.';
      this.execHintWarn = false;
      return;
    }
  }

  /** True if the *draft* is a container-lifecycle recipe (amber dialog warning). */
  draftIsContainerLifecycle(): boolean {
    if (!this.draft) return false;
    return isContainerLifecycleRecipe({ exec: this.draft.exec, args: this.draftArgvOrEmpty() });
  }

  /** True if the *draft* matches the broader state-changing heuristic (amber dialog warning). */
  draftIsStateChanging(): boolean {
    if (!this.draft) return false;
    return isStateChangingRecipe({ exec: this.draft.exec, args: this.draftArgvOrEmpty() });
  }

  /** `host_exec_resolve_executable` — fills `exec` with the resolved path. */
  async findExecOnPath(): Promise<void> {
    if (!this.draft) return;
    const name = this.draft.exec.trim();
    if (!name || name.includes('/') || name.includes('\\')) {
      this.execHint = 'Type a bare command name first (e.g. docker, gradle) — then "find on PATH".';
      this.execHintWarn = true;
      this.cdr.markForCheck();
      return;
    }
    this.execResolving = true;
    this.cdr.markForCheck();
    try {
      const resolved = await this.tauri.invoke<string | null>('host_exec_resolve_executable', {
        name,
      });
      if (!this.draft) return;
      if (resolved) {
        this.draft.exec = resolved;
        this.recomputeExecHint();
      } else {
        this.execHint = `"${name}" not found on the recovered PATH — use "browse…" to pick it.`;
        this.execHintWarn = true;
      }
    } catch (e: unknown) {
      this.execHint = this.errMsg(e);
      this.execHintWarn = true;
    }
    this.execResolving = false;
    this.cdr.markForCheck();
  }

  /** OS file picker for `exec` (for tools not on PATH, e.g. Docker Desktop). */
  async browseExec(): Promise<void> {
    if (!this.draft) return;
    try {
      const picked = await openOsDialog({
        multiple: false,
        directory: false,
        title: 'Pick an executable',
      });
      if (typeof picked === 'string' && picked) {
        this.draft.exec = picked;
        this.recomputeExecHint();
        this.cdr.markForCheck();
      }
    } catch (e: unknown) {
      this.execHint = this.errMsg(e);
      this.execHintWarn = true;
      this.cdr.markForCheck();
    }
  }

  /**
   * Validates the draft, builds a {@link HostExecCommand}, and merges it into
   * the working copy (add or replace).
   */
  commitDraft(): void {
    if (!this.draft) return;
    const built = this.buildFromDraft(this.draft);
    if (typeof built === 'string') {
      this.draftError = built;
      this.cdr.markForCheck();
      return;
    }
    // Uniqueness against the *other* recipes.
    const dupe = this.commands.some(
      (c) => c.name === built.name && c.name !== this.draft!.originalName
    );
    if (dupe) {
      this.draftError = `A command named "${built.name}" already exists.`;
      this.cdr.markForCheck();
      return;
    }
    if (this.draft.editing) {
      this.commands = this.commands.map((c) => (c.name === this.draft!.originalName ? built : c));
    } else {
      this.commands = [...this.commands, built];
    }
    this.draft = null;
    this.draftError = '';
    this.cdr.markForCheck();
  }

  /**
   * Builds and validates one recipe from a draft. Returns the recipe, or an
   * error string. Mirrors `host_exec::validate_host_exec_config` (per-recipe).
   * @param d - The draft form state to validate and convert.
   */
  private buildFromDraft(d: RecipeDraft): HostExecCommand | string {
    const name = d.name.trim();
    if (!HOST_EXEC_RECIPE_NAME_RE.test(name)) {
      return 'Name must be snake_case: start with a lowercase letter, then lowercase letters / digits / underscores (max 64 chars).';
    }
    const exec = d.exec.trim();
    if (!exec) return 'Executable is required.';
    if (exec.includes('\0') || exec.includes('\n') || exec.includes('=')) {
      return 'Executable must not contain NUL, newlines, or "=".';
    }
    if (exec.split(/[/\\]/).includes('..')) return 'Executable path must not contain "..".';
    const execBase = execBasenameLower(exec);
    if (HOST_EXEC_SHELL_LAUNCHERS.includes(execBase)) {
      return `"${execBase}" is a shell / eval launcher and is not allowed — it would let Claude run arbitrary commands. Point Host Exec at the actual tool.`;
    }
    const parsed = parseArgLine(d.argLine);
    if ('error' in parsed) return parsed.error;
    const args = parsed.args; // an empty list is valid — the recipe is just `exec`
    for (const a of args) {
      if (a.includes('\0') || a.includes('\n'))
        return 'Arguments must not contain NUL or newlines.';
    }
    // Parameters.
    const params: { name: string; pattern: string; maxLen?: number }[] = [];
    const paramNames = new Set<string>();
    for (const p of d.params) {
      const pn = p.name.trim();
      if (!HOST_EXEC_PARAM_NAME_RE.test(pn)) {
        return `Parameter name "${p.name || '(blank)'}" must be snake_case.`;
      }
      if (paramNames.has(pn)) return `Duplicate parameter name "${pn}".`;
      paramNames.add(pn);
      const pat = p.pattern.trim();
      if (!pat) return `Parameter "${pn}" needs a regex.`;
      if (pat.includes('\0') || pat.includes('\n'))
        return `Parameter "${pn}" regex must not contain NUL or newlines.`;
      if (pat.length > 4096) return `Parameter "${pn}" regex is too long (max 4096 chars).`;
      // Sanity-compile (the worker does the authoritative anchored match).
      try {
        new RegExp(pat);
      } catch {
        return `Parameter "${pn}" regex does not compile.`;
      }
      let maxLen: number | undefined;
      if (p.maxLen.trim() !== '') {
        const n = Number(p.maxLen.trim());
        if (!Number.isInteger(n) || n <= 0 || n > 65536) {
          return `Parameter "${pn}" max length must be a positive integer ≤ 65536.`;
        }
        maxLen = n;
      }
      params.push(maxLen != null ? { name: pn, pattern: pat, maxLen } : { name: pn, pattern: pat });
    }
    // Every {token} in args must have a matching param; flag bare-{param}
    // on meta-tool execs.
    const isMetaTool = HOST_EXEC_META_TOOLS.includes(execBase);
    for (const a of args) {
      for (const ref of argParamRefs(a)) {
        if (!paramNames.has(ref)) {
          return `Argument "${a}" references parameter "{${ref}}" which is not defined.`;
        }
      }
      if (isMetaTool && isBareParamArg(a)) {
        return `"${execBase}" with a bare parameter ("${a}") would let Claude run anything through ${execBase}. Use a literal sub-command (e.g. ${execBase} test) or a more specific executable.`;
      }
    }
    // cwdSub.
    const cwdSub = d.cwdSub.trim();
    if (cwdSub) {
      if (cwdSub.includes('\0')) return 'Subdirectory must not contain NUL.';
      if (cwdSub.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cwdSub)) {
        return 'Subdirectory must be a relative path inside the project, not absolute.';
      }
      if (cwdSub.split(/[/\\]/).includes('..')) return 'Subdirectory must not contain "..".';
    }
    // env.
    const env: Record<string, string> = {};
    for (const e of d.env) {
      const k = e.key.trim();
      if (!k) return 'Environment variable name must not be blank.';
      if (k.includes('\0') || k.includes('\n') || k.includes('=')) {
        return `Environment variable name "${e.key}" must not contain NUL, newlines, or "=".`;
      }
      if (HOST_EXEC_RESERVED_ENV_KEYS.some((r) => r.toLowerCase() === k.toLowerCase())) {
        return `"${k}" is a reserved environment variable and cannot be set by a recipe.`;
      }
      if (k in env) return `Duplicate environment variable "${k}".`;
      if (e.value.includes('\0') || e.value.includes('\n')) {
        return `Environment variable "${k}" value must not contain NUL or newlines.`;
      }
      env[k] = e.value;
    }

    const cmd: HostExecCommand = { name, exec, args };
    if (cwdSub) cmd.cwdSub = cwdSub;
    if (params.length > 0) cmd.params = params;
    if (Object.keys(env).length > 0) cmd.env = env;
    return cmd;
  }

  /**
   * Validates the whole working copy (used before `save`). Returns an error
   * string, or `''` if valid.
   * @param cmds - The recipe list to validate.
   */
  private validateAll(cmds: HostExecCommand[]): string {
    const seen = new Set<string>();
    for (const c of cmds) {
      if (seen.has(c.name)) return `Duplicate command name "${c.name}".`;
      seen.add(c.name);
      // Re-run the per-recipe checks via a draft round-trip.
      const draft: RecipeDraft = {
        editing: true,
        originalName: c.name,
        presetKey: '',
        name: c.name,
        exec: c.exec,
        argLine: joinArgLine(c.args),
        cwdSub: c.cwdSub ?? '',
        params: (c.params ?? []).map((p) => ({
          name: p.name,
          pattern: p.pattern,
          maxLen: p.maxLen != null ? String(p.maxLen) : '',
        })),
        env: Object.entries(c.env ?? {}).map(([key, value]) => ({ key, value })),
      };
      const built = this.buildFromDraft(draft);
      if (typeof built === 'string') return `Command "${c.name}": ${built}`;
    }
    return '';
  }

  // ---- misc --------------------------------------------------------------

  private errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }
}
