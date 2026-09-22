import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { CdkTextareaAutosize } from '@angular/cdk/text-field';
import { ComposerComponent } from './composer.component';
import { ProjectStateService, type AuthStatusResponse } from '../../services/project-state.service';
import { TauriService } from '../../services/tauri.service';
import { LoggerService } from '../../services/logger.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import { makeMockLogger } from '../../testing/mock-logger';
import { SlashService } from '../slash/slash.service';

class ProjectStateStub {
  readonly activeProject = signal<string | null>(null);
}

class SlashServiceStub {
  readonly commands = signal<readonly unknown[]>([]);
  readonly discovering = signal(false);
  readonly source = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly unavailable = signal(false);
  readonly isLoadingEmpty = signal(false);
  refresh = vi.fn(async () => undefined);
  filter(_query: string): readonly unknown[] {
    return [];
  }
}

describe('ComposerComponent', () => {
  let fixture: ComponentFixture<ComposerComponent>;
  let component: ComposerComponent;
  let rootEl: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ComposerComponent],
      providers: [
        { provide: ProjectStateService, useClass: ProjectStateStub },
        { provide: SlashService, useClass: SlashServiceStub },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ComposerComponent);
    component = fixture.componentInstance;
    rootEl = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  });

  function textarea(): HTMLTextAreaElement {
    const el = rootEl.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]');
    if (!el) throw new Error('textarea not rendered');
    return el;
  }

  function sendButton(): HTMLButtonElement {
    const el = rootEl.querySelector<HTMLButtonElement>('[data-testid="chat-send"]');
    if (!el) throw new Error('send button not rendered');
    return el;
  }

  function slashButton(): HTMLButtonElement {
    const el = rootEl.querySelector<HTMLButtonElement>('[data-testid="composer-slash"]');
    if (!el) throw new Error('slash button not rendered');
    return el;
  }

  describe('happy path — submit', () => {
    it('emits submitted(value) and resets form when Enter is pressed without Shift', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v.payload));
      component.text.setValue('hello claude');
      fixture.detectChanges();

      const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false });
      const preventSpy = vi.spyOn(event, 'preventDefault');
      textarea().dispatchEvent(event);

      expect(preventSpy).toHaveBeenCalled();
      expect(emitted).toEqual(['hello claude']);
      expect(component.text.value).toBe('');
    });

    it('emits submitted(value) when send button is clicked', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v.payload));
      component.text.setValue('ping');
      fixture.detectChanges();

      sendButton().click();

      expect(emitted).toEqual(['ping']);
    });

    it('trims whitespace before emitting', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v.payload));
      component.text.setValue('  hello  ');
      fixture.detectChanges();

      sendButton().click();

      expect(emitted).toEqual(['hello']);
    });
  });

  describe('Shift+Enter', () => {
    it('does NOT submit when Shift+Enter is pressed', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v.payload));
      component.text.setValue('line one');
      fixture.detectChanges();

      const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true });
      const preventSpy = vi.spyOn(event, 'preventDefault');
      textarea().dispatchEvent(event);

      expect(preventSpy).not.toHaveBeenCalled();
      expect(emitted).toEqual([]);
      expect(component.text.value).toBe('line one');
    });
  });

  describe('edge cases', () => {
    it('does not emit when submitting empty text', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v.payload));
      component.text.setValue('');
      fixture.detectChanges();

      sendButton().click();

      expect(emitted).toEqual([]);
    });

    it('does not emit when submitting whitespace-only text', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v.payload));
      component.text.setValue('   \n  ');
      fixture.detectChanges();

      sendButton().click();

      expect(emitted).toEqual([]);
    });

    it('handles very long text', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v.payload));
      const longText = 'x'.repeat(10_000);
      component.text.setValue(longText);
      fixture.detectChanges();

      sendButton().click();

      expect(emitted).toEqual([longText]);
    });

    it('does not emit when submitting a lone slash (skill-menu trigger)', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v.payload));
      component.text.setValue('/');
      fixture.detectChanges();

      sendButton().click();

      expect(emitted).toEqual([]);
    });

    it('does not emit when submitting a slash with surrounding whitespace', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v.payload));
      component.text.setValue('  /  ');
      fixture.detectChanges();

      sendButton().click();

      expect(emitted).toEqual([]);
    });

    it('emits a real slash command (slash + name)', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v.payload));
      component.text.setValue('/code-review');
      fixture.detectChanges();

      component.submit();

      expect(emitted).toEqual(['/code-review']);
    });

    it('CAN submit a lone `/` when an image attachment is present (ADR-065)', () => {
      component.text.setValue('/');
      component.attachments.set([
        {
          id: 'a1',
          filename: 'img.png',
          previewUrl: 'blob:x',
          preprocessed: {
            attachment: {
              filename: 'img.png',
              mediaType: 'image/png',
              containerPath: '/workspace/.speedwave/pastes/img.png',
              hostPath: '/tmp/img.png',
            },
            previewUrl: 'blob:x',
            width: 1,
            height: 1,
            sizeBytes: 1,
          },
        },
      ]);
      fixture.detectChanges();
      expect(component.canSubmit()).toBe(true);
    });
  });

  describe('disabled state', () => {
    it('prevents submission via Enter when disabled', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v.payload));
      fixture.componentRef.setInput('disabled', true);
      component.text.setValue('blocked');
      fixture.detectChanges();

      const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false });
      textarea().dispatchEvent(event);

      expect(emitted).toEqual([]);
      expect(component.text.value).toBe('blocked');
    });

    it('send button is disabled when text is empty', () => {
      component.text.setValue('');
      fixture.detectChanges();
      expect(sendButton().hasAttribute('disabled')).toBe(true);
    });

    it('send button is disabled when disabled input is true', () => {
      fixture.componentRef.setInput('disabled', true);
      component.text.setValue('ready');
      fixture.detectChanges();
      expect(sendButton().hasAttribute('disabled')).toBe(true);
    });

    it('send button is enabled when text is present and not disabled', () => {
      component.text.setValue('ready');
      fixture.detectChanges();
      expect(sendButton().hasAttribute('disabled')).toBe(false);
    });

    it('textarea disabled attribute reflects disabled input', () => {
      fixture.componentRef.setInput('disabled', true);
      fixture.detectChanges();
      expect(textarea().hasAttribute('disabled')).toBe(true);

      fixture.componentRef.setInput('disabled', false);
      fixture.detectChanges();
      expect(textarea().hasAttribute('disabled')).toBe(false);
    });
  });

  describe('slash menu trigger', () => {
    function dispatchInputAt(value: string, caretPos: number): void {
      const ta = textarea();
      component.text.setValue(value);
      ta.value = value;
      ta.setSelectionRange(caretPos, caretPos);
      ta.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    }

    it('opens the slash popover when typing `/` at position 0', () => {
      const events: boolean[] = [];
      component.slashOpenChange.subscribe((e) => events.push(e));
      dispatchInputAt('/', 1);
      expect(component.slashOpen()).toBe(true);
      expect(events).toEqual([true]);
    });

    it('opens the slash popover when typing `/` after leading whitespace', () => {
      dispatchInputAt('  /', 3);
      expect(component.slashOpen()).toBe(true);
    });

    it('does NOT open the slash popover when `/` appears mid-sentence', () => {
      dispatchInputAt('hello /', 7);
      expect(component.slashOpen()).toBe(false);
    });

    it('updates the slash query when the user types after `/`', () => {
      dispatchInputAt('/rev', 4);
      expect(component.slashOpen()).toBe(true);
      expect(component.slashQuery()).toBe('rev');
    });

    it('re-runs discovery on open when the last result was unavailable', () => {
      const projectState = TestBed.inject(ProjectStateService) as unknown as ProjectStateStub;
      const slash = TestBed.inject(SlashService) as unknown as SlashServiceStub;
      projectState.activeProject.set('acme');
      slash.commands.set([]);
      slash.source.set('Unavailable');
      dispatchInputAt('/', 1);
      expect(slash.refresh).toHaveBeenCalledWith('acme');
    });

    it('keeps a real discovery on open instead of re-running it', () => {
      const projectState = TestBed.inject(ProjectStateService) as unknown as ProjectStateStub;
      const slash = TestBed.inject(SlashService) as unknown as SlashServiceStub;
      projectState.activeProject.set('acme');
      slash.commands.set([{ name: 'speedwave-tdd' }]);
      slash.source.set('Init');
      dispatchInputAt('/', 1);
      expect(slash.refresh).not.toHaveBeenCalled();
    });

    it('opens the slash popover when the slash toolbar button is clicked and inserts `/`', async () => {
      const events: boolean[] = [];
      component.slashOpenChange.subscribe((e) => events.push(e));
      slashButton().click();
      await Promise.resolve();
      fixture.detectChanges();
      expect(component.text.value).toBe('/');
      expect(component.slashOpen()).toBe(true);
      expect(events).toContain(true);
    });

    it('slash button click does nothing when disabled', () => {
      const events: boolean[] = [];
      component.slashOpenChange.subscribe((e) => events.push(e));
      fixture.componentRef.setInput('disabled', true);
      fixture.detectChanges();
      slashButton().click();
      expect(component.slashOpen()).toBe(false);
      expect(events).toEqual([]);
    });
  });

  describe('ARIA', () => {
    it('textarea has aria-label "Compose message"', () => {
      expect(textarea().getAttribute('aria-label')).toBe('Compose message');
    });

    it('send button has aria-label "Send"', () => {
      expect(sendButton().getAttribute('aria-label')).toBe('Send');
    });
  });

  describe('placeholder', () => {
    it('uses default placeholder when none provided', () => {
      expect(textarea().getAttribute('placeholder')).toBe('message speedwave...');
    });

    it('honors custom placeholder input', () => {
      fixture.componentRef.setInput('placeholder', 'say something');
      fixture.detectChanges();
      expect(textarea().getAttribute('placeholder')).toBe('say something');
    });

    it('swaps to "queue next message..." when streaming', () => {
      fixture.componentRef.setInput('streaming', true);
      fixture.detectChanges();
      expect(textarea().getAttribute('placeholder')).toBe('queue next message...');
    });
  });

  describe('queued message (ADR-045)', () => {
    function queuedRow(): HTMLElement | null {
      return rootEl.querySelector<HTMLElement>('[data-testid="composer-queued"]');
    }

    function queuedText(): HTMLElement | null {
      return rootEl.querySelector<HTMLElement>('[data-testid="composer-queued-text"]');
    }

    function queuedCancel(): HTMLButtonElement | null {
      return rootEl.querySelector<HTMLButtonElement>('[data-testid="composer-queued-cancel"]');
    }

    it('does not render queued row when queuedText is empty', () => {
      expect(queuedRow()).toBeNull();
    });

    it('renders queued preview with truncation past 80 chars', () => {
      const long = 'a'.repeat(120);
      fixture.componentRef.setInput('queuedText', long);
      fixture.detectChanges();
      expect(queuedRow()).not.toBeNull();
      const txt = queuedText()?.textContent ?? '';
      expect(txt.length).toBeLessThanOrEqual(80);
      expect(txt.endsWith('…')).toBe(true);
    });

    it('renders short queued text verbatim', () => {
      fixture.componentRef.setInput('queuedText', 'pick up where we left off');
      fixture.detectChanges();
      expect(queuedText()?.textContent?.trim()).toBe('pick up where we left off');
    });

    it('cancel button has aria-label "Cancel queued message"', () => {
      fixture.componentRef.setInput('queuedText', 'next');
      fixture.detectChanges();
      expect(queuedCancel()?.getAttribute('aria-label')).toBe('Cancel queued message');
    });

    it('clicking cancel emits queueCancelled', () => {
      fixture.componentRef.setInput('queuedText', 'next');
      fixture.detectChanges();
      const events: number[] = [];
      component.queueCancelled.subscribe(() => events.push(1));
      queuedCancel()!.click();
      expect(events).toEqual([1]);
    });

    it('emits queueRequested(text) instead of submitted when streaming', () => {
      fixture.componentRef.setInput('streaming', true);
      fixture.detectChanges();
      const submitted: string[] = [];
      const queued: string[] = [];
      component.submitted.subscribe((v) => submitted.push(v.payload));
      component.queueRequested.subscribe((v) => queued.push(v));
      component.text.setValue('next turn');
      fixture.detectChanges();
      component.submit();
      expect(submitted).toEqual([]);
      expect(queued).toEqual(['next turn']);
      expect(component.text.value).toBe('');
    });

    it('emits submitted (not queueRequested) when not streaming', () => {
      const submitted: string[] = [];
      const queued: string[] = [];
      component.submitted.subscribe((v) => submitted.push(v.payload));
      component.queueRequested.subscribe((v) => queued.push(v));
      component.text.setValue('regular send');
      fixture.detectChanges();
      sendButton().click();
      expect(submitted).toEqual(['regular send']);
      expect(queued).toEqual([]);
    });

    it('disabled input still blocks both routes', () => {
      fixture.componentRef.setInput('disabled', true);
      fixture.componentRef.setInput('streaming', true);
      fixture.detectChanges();
      const submitted: string[] = [];
      const queued: string[] = [];
      component.submitted.subscribe((v) => submitted.push(v.payload));
      component.queueRequested.subscribe((v) => queued.push(v));
      component.text.enable({ emitEvent: false });
      component.text.setValue('blocked');
      component.text.disable({ emitEvent: false });
      fixture.detectChanges();
      expect(component.canSubmit()).toBe(false);
      component.submit();
      expect(submitted).toEqual([]);
      expect(queued).toEqual([]);
    });
  });

  describe('plan mode toggle', () => {
    it('starts in act mode (planMode is false)', () => {
      expect(component.planMode()).toBe(false);
    });

    it('togglePlanMode flips the signal', () => {
      component.togglePlanMode();
      expect(component.planMode()).toBe(true);
      component.togglePlanMode();
      expect(component.planMode()).toBe(false);
    });

    it('emits the raw text in act mode', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v.payload));
      component.text.setValue('refactor this');
      fixture.detectChanges();
      component.submit();
      expect(emitted).toEqual(['refactor this']);
    });

    it('prefixes the message with the plan-mode directive when active', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v.payload));
      component.togglePlanMode();
      component.text.setValue('refactor this');
      fixture.detectChanges();
      component.submit();
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toContain('Plan mode');
      expect(emitted[0]).toContain('refactor this');
      expect(emitted[0].endsWith('refactor this')).toBe(true);
    });

    it('plan mode survives across submissions until toggled off', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v.payload));
      component.togglePlanMode();
      component.text.setValue('first');
      fixture.detectChanges();
      component.submit();
      component.text.setValue('second');
      fixture.detectChanges();
      component.submit();
      expect(emitted[0]).toContain('Plan mode');
      expect(emitted[1]).toContain('Plan mode');
      expect(emitted[0]).toContain('first');
      expect(emitted[1]).toContain('second');
    });
  });

  describe('model selector', () => {
    it('renders app-model-selector instead of the old read-only model span', () => {
      const selector = fixture.debugElement.query(By.css('app-model-selector'));
      expect(selector).toBeTruthy();
    });

    it('forwards streaming() to the model selector', () => {
      fixture.componentRef.setInput('streaming', true);
      fixture.detectChanges();
      const selector = fixture.debugElement.query(By.css('app-model-selector'));
      expect(selector.componentInstance.streaming()).toBe(true);
    });

    it('re-emits the model selector modelSelected event unchanged for the parent to handle', () => {
      const selector = fixture.debugElement.query(By.css('app-model-selector'));
      const emissions: unknown[] = [];
      fixture.componentInstance.modelSelected.subscribe((sel) => emissions.push(sel));

      selector.triggerEventHandler('modelSelected', {
        catalogId: 'claude-sonnet-5',
        wireId: 'claude-sonnet-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
      });

      expect(emissions).toEqual([
        {
          catalogId: 'claude-sonnet-5',
          wireId: 'claude-sonnet-5',
          providerId: 'anthropic',
          kind: 'anthropic_oauth',
        },
      ]);
    });
  });

  describe('overlayWidth', () => {
    it('reflects the textarea width read at call time, not a cached first read', () => {
      const el = textarea();
      Object.defineProperty(el, 'offsetWidth', { value: 300, configurable: true });
      expect(component.overlayWidth()).toBe('300px');

      Object.defineProperty(el, 'offsetWidth', { value: 500, configurable: true });
      expect(component.overlayWidth()).toBe('500px');
    });
  });

  describe('contextLabel', () => {
    it('does not render the context span when contextLabel is empty (default)', () => {
      const span = rootEl.querySelector('[data-testid="composer-context"]');
      expect(span).toBeNull();
    });

    it('renders the bound contextLabel text', () => {
      fixture.componentRef.setInput('contextLabel', '200k');
      fixture.detectChanges();
      const span = rootEl.querySelector('[data-testid="composer-context"]');
      expect(span?.textContent?.trim()).toBe('200k');
    });
  });

  describe('manual resize', () => {
    function autosize(): CdkTextareaAutosize {
      return fixture.debugElement
        .query(By.directive(CdkTextareaAutosize))
        .injector.get(CdkTextareaAutosize);
    }

    function handle(): HTMLElement {
      const el = rootEl.querySelector<HTMLElement>('[data-testid="composer-resize-handle"]');
      if (!el) throw new Error('resize handle not rendered');
      return el;
    }

    it('renders a resize handle', () => {
      expect(rootEl.querySelector('[data-testid="composer-resize-handle"]')).not.toBeNull();
    });

    it('disables autosize and applies a taller height when dragged up', () => {
      component.onResizeStart();
      expect(autosize().enabled).toBe(false);
      component.onResizeBy(300);
      const target = Math.min(Math.round(window.innerHeight * 0.6), Math.max(56, 300));
      expect(textarea().style.height).toBe(`${target}px`);
    });

    it('clamps to the 56px floor for small or negative deltas', () => {
      component.onResizeStart();
      component.onResizeBy(-500);
      expect(textarea().style.height).toBe('56px');
    });

    it('clamps to the viewport-derived ceiling for large deltas', () => {
      component.onResizeStart();
      component.onResizeBy(100000);
      const ceiling = Math.round(window.innerHeight * 0.6);
      expect(textarea().style.height).toBe(`${ceiling}px`);
    });

    it('lifts the CDK row cap so the drag can exceed 8 rows', () => {
      component.onResizeStart();
      expect(textarea().style.maxHeight).toBe('none');
      component.onResizeBy(100000);
      const ceiling = Math.round(window.innerHeight * 0.6);
      expect(textarea().style.height).toBe(`${ceiling}px`);
    });

    it('reset re-enables autosize, clears inline height and restores the row cap', () => {
      component.onResizeStart();
      component.onResizeBy(300);
      expect(autosize().enabled).toBe(false);
      expect(textarea().style.maxHeight).toBe('none');
      component.onResizeReset();
      expect(autosize().enabled).toBe(true);
      expect(textarea().style.height).toBe('');
      expect(textarea().style.maxHeight).toBe('');
    });

    it('submitting a message restores autosize (does not stay stuck tall)', () => {
      component.text.setValue('a long message');
      fixture.detectChanges();
      component.onResizeStart();
      component.onResizeBy(300);
      expect(autosize().enabled).toBe(false);
      component.submit();
      expect(autosize().enabled).toBe(true);
      expect(textarea().style.height).toBe('');
      expect(textarea().style.maxHeight).toBe('');
    });

    it('focusInput (new conversation) restores autosize', () => {
      component.onResizeStart();
      component.onResizeBy(300);
      expect(autosize().enabled).toBe(false);
      component.focusInput();
      expect(autosize().enabled).toBe(true);
      expect(textarea().style.maxHeight).toBe('');
    });

    it('tracks aria value: base on start, target on drag, null after reset', () => {
      component.onResizeStart();
      expect(component.resizeValueNow()).toBe(0);
      component.onResizeBy(300);
      const target = Math.min(Math.round(window.innerHeight * 0.6), Math.max(56, 300));
      expect(component.resizeValueNow()).toBe(target);
      expect(component.resizeValueMax()).toBe(Math.round(window.innerHeight * 0.6));
      component.onResizeReset();
      expect(component.resizeValueNow()).toBeNull();
      expect(component.resizeValueMax()).toBe(0);
    });

    it('renders the full aria value set only while resizing', () => {
      expect(handle().hasAttribute('aria-valuenow')).toBe(false);
      expect(handle().hasAttribute('aria-valuemin')).toBe(false);
      expect(handle().hasAttribute('aria-valuemax')).toBe(false);
      component.onResizeStart();
      component.onResizeBy(300);
      fixture.detectChanges();
      expect(handle().getAttribute('aria-valuemin')).toBe('56');
      expect(handle().hasAttribute('aria-valuenow')).toBe(true);
      expect(handle().hasAttribute('aria-valuemax')).toBe(true);
      component.onResizeReset();
      fixture.detectChanges();
      expect(handle().hasAttribute('aria-valuemin')).toBe(false);
      expect(handle().hasAttribute('aria-valuemax')).toBe(false);
    });

    it('onResizeEnd is a no-op (no throw) when the slash menu is closed', () => {
      component.onResizeStart();
      expect(() => component.onResizeEnd()).not.toThrow();
    });

    it('ArrowUp on the handle grows the textarea and disables autosize', () => {
      handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      expect(autosize().enabled).toBe(false);
      expect(textarea().style.height).toBe('56px');
    });

    it('dragging the handle up applies the pointer delta as height', () => {
      const h = handle();
      h.dispatchEvent(new PointerEvent('pointerdown', { clientY: 200, button: 0, pointerId: 1 }));
      h.dispatchEvent(new PointerEvent('pointermove', { clientY: 100, pointerId: 1 }));
      expect(textarea().style.height).toBe('100px');
      h.dispatchEvent(new PointerEvent('pointerup', { clientY: 100, pointerId: 1 }));
    });

    it('does not resize via the handle while disabled', () => {
      fixture.componentRef.setInput('disabled', true);
      fixture.detectChanges();
      handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      expect(textarea().style.height).toBe('');
    });
  });

  describe('staged transcript', () => {
    function transcriptRow(): HTMLElement | null {
      return rootEl.querySelector<HTMLElement>('[data-testid="composer-transcript"]');
    }

    function detachButton(): HTMLButtonElement | null {
      return rootEl.querySelector<HTMLButtonElement>('[data-testid="composer-transcript-detach"]');
    }

    it('renders no transcript row by default', () => {
      expect(transcriptRow()).toBeNull();
    });

    it('names the destination so the user knows the text leaves the machine', () => {
      fixture.componentRef.setInput('transcriptAttached', true);
      fixture.detectChanges();
      expect(transcriptRow()?.textContent).toContain('next message');
      expect(transcriptRow()?.textContent).toContain('LLM provider');
    });

    it('emits transcriptDetached when the row is unpinned', () => {
      const detached: number[] = [];
      component.transcriptDetached.subscribe(() => detached.push(1));
      fixture.componentRef.setInput('transcriptAttached', true);
      fixture.detectChanges();
      expect(detachButton()?.getAttribute('aria-label')).toBe('Detach meeting transcript');
      detachButton()!.click();
      expect(detached.length).toBe(1);
    });

    it('loads a draft into the field and reports it applied', async () => {
      const applied: number[] = [];
      component.draftApplied.subscribe(() => applied.push(1));
      fixture.componentRef.setInput('draftText', 'summarize the meeting');
      fixture.detectChanges();
      await fixture.whenStable();
      expect(component.text.value).toBe('summarize the meeting');
      expect(applied.length).toBe(1);
      expect(textarea().selectionStart).toBe('summarize the meeting'.length);
    });

    it('leaves user edits alone once the parent clears the draft', async () => {
      fixture.componentRef.setInput('draftText', 'summarize the meeting');
      fixture.detectChanges();
      component.text.setValue('my own prompt');
      fixture.componentRef.setInput('draftText', '');
      fixture.detectChanges();
      await fixture.whenStable();
      expect(component.text.value).toBe('my own prompt');
    });

    it('does not submit an empty field, so a cleared prompt sends nothing', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v.payload));
      fixture.componentRef.setInput('transcriptAttached', true);
      component.text.setValue('');
      fixture.detectChanges();
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false }));
      expect(emitted).toEqual([]);
      expect(transcriptRow()).not.toBeNull();
    });
  });

  describe('attachment error', () => {
    function attachmentErrorEl(): HTMLElement | null {
      return rootEl.querySelector<HTMLElement>('[data-testid="composer-attachment-error"]');
    }

    function makeDropEvent(files: File[]): DragEvent {
      const dataTransfer = { types: ['Files'], files, dropEffect: 'none' };
      const ev = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer, configurable: true });
      return ev;
    }

    it('shows an English error when an image is dropped with no active project', () => {
      const dropTarget = rootEl.querySelector('[appFileDrop]') as HTMLElement;
      const file = new File(['x'], 'a.png', { type: 'image/png' });

      dropTarget.dispatchEvent(makeDropEvent([file]));
      fixture.detectChanges();

      expect(attachmentErrorEl()?.textContent?.trim()).toBe(
        'Select a project before attaching an image.'
      );
    });
  });
});

describe('ComposerComponent slash discovery with the real project and slash services', () => {
  const READY: AuthStatusResponse = {
    status: 'ready',
    api_key_configured: false,
    oauth_authenticated: true,
    needs_anthropic_auth: true,
    provider_configured: true,
  };

  let projectState: ProjectStateService;
  let slash: SlashService;
  let discoveries: number;

  beforeEach(() => {
    discoveries = 0;
    const tauri = new MockTauriService();
    tauri.invokeHandler = (cmd) => {
      if (cmd !== 'list_slash_commands') return Promise.resolve(undefined);
      discoveries++;
      return Promise.resolve({ commands: [], source: 'Init' });
    };
    TestBed.configureTestingModule({
      imports: [ComposerComponent],
      providers: [
        { provide: TauriService, useValue: tauri },
        { provide: LoggerService, useValue: makeMockLogger() },
      ],
    });
    projectState = TestBed.inject(ProjectStateService);
    slash = TestBed.inject(SlashService);
    projectState.activeProject.set('acme');
  });

  function mountComposer(): ComponentFixture<ComposerComponent> {
    const created = TestBed.createComponent(ComposerComponent);
    created.detectChanges();
    return created;
  }

  async function signIn(): Promise<void> {
    projectState.forceUnconfigured();
    projectState.applyAuthStatus(READY);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  it('refreshes once per sign-in however many composers were mounted before', async () => {
    const refresh = vi.spyOn(slash, 'refresh');
    mountComposer().destroy();
    mountComposer().destroy();
    const live = mountComposer();

    await signIn();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(discoveries).toBe(1);
    live.destroy();
  });

  it('refreshes once per sign-in while no composer is mounted', async () => {
    mountComposer().destroy();

    await signIn();
    await signIn();

    expect(discoveries).toBe(2);
  });
});
