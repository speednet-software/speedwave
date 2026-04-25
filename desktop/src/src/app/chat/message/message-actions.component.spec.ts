import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MessageActionsComponent } from './message-actions.component';
import { ChatStateService } from '../../services/chat-state.service';

class FakeChatState {
  isStreaming = false;
  copyMessage = vi.fn().mockResolvedValue(true);
  retryLastAssistant = vi.fn().mockResolvedValue(undefined);
  canRetryLastAssistant = vi.fn().mockReturnValue(true);
}

describe('MessageActionsComponent', () => {
  let component: MessageActionsComponent;
  let fixture: ComponentFixture<MessageActionsComponent>;
  let chat: FakeChatState;

  function copyButton(): HTMLButtonElement {
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="message-copy"]'
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    return btn as HTMLButtonElement;
  }

  function retryButton(): HTMLButtonElement | null {
    return fixture.nativeElement.querySelector(
      '[data-testid="message-retry"]'
    ) as HTMLButtonElement | null;
  }

  /**
   * Re-runs CD on the OnPush component. Direct mutation of `chat` state does
   * not mark the view dirty — toggling an input via `setInput` is the cheapest
   * way to dirty the OnPush input cache and re-evaluate `[disabled]` bindings.
   */
  function refresh(): void {
    fixture.componentRef.setInput('entryIndex', component.entryIndex + 1);
    fixture.detectChanges();
    fixture.componentRef.setInput('entryIndex', component.entryIndex - 1);
    fixture.detectChanges();
  }

  beforeEach(async () => {
    chat = new FakeChatState();
    vi.useFakeTimers();
    await TestBed.configureTestingModule({
      imports: [MessageActionsComponent],
      providers: [{ provide: ChatStateService, useValue: chat }],
    }).compileComponents();

    fixture = TestBed.createComponent(MessageActionsComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('entryIndex', 3);
    fixture.componentRef.setInput('isLast', true);
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Happy path ──────────────────────────────────────────────────

  it('renders copy and retry buttons with ARIA labels by default', () => {
    const copy = copyButton();
    const retry = retryButton();
    expect(copy.getAttribute('aria-label')).toBe('Copy message');
    expect(retry).not.toBeNull();
    expect(retry?.getAttribute('aria-label')).toBe('Retry last response');
  });

  it('copy button is enabled and retry button is enabled when canRetry is true and not streaming', () => {
    expect(copyButton().disabled).toBe(false);
    expect(retryButton()?.disabled).toBe(false);
  });

  it('clicking copy invokes ChatStateService.copyMessage with entryIndex', async () => {
    copyButton().click();
    await Promise.resolve();
    expect(chat.copyMessage).toHaveBeenCalledWith(3);
  });

  it('clicking retry invokes ChatStateService.retryLastAssistant', async () => {
    retryButton()?.click();
    await Promise.resolve();
    expect(chat.retryLastAssistant).toHaveBeenCalledTimes(1);
  });

  // ── Copy confirmation timing ────────────────────────────────────

  it('shows "✓ copied" for 1.5s after a successful copy, then reverts', async () => {
    copyButton().click();
    // Drain the pending copy promise.
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(copyButton().textContent?.trim()).toBe('✓ copied');
    expect(copyButton().getAttribute('aria-label')).toBe('Copied to clipboard');
    // 1499ms before — still showing
    vi.advanceTimersByTime(1_499);
    fixture.detectChanges();
    expect(copyButton().textContent?.trim()).toBe('✓ copied');
    // After 1500ms total — reverted
    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(copyButton().textContent?.trim()).toBe('Copy');
    expect(copyButton().getAttribute('aria-label')).toBe('Copy message');
  });

  it('does NOT show "✓ copied" when copyMessage returns false', async () => {
    chat.copyMessage = vi.fn().mockResolvedValue(false);
    copyButton().click();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(copyButton().textContent?.trim()).toBe('Copy');
  });

  // ── Disabled / hidden states ────────────────────────────────────

  it('hides retry button when isLast is false', () => {
    fixture.componentRef.setInput('isLast', false);
    fixture.detectChanges();
    expect(retryButton()).toBeNull();
  });

  it('disables retry button when chat.isStreaming is true', () => {
    // The real ChatStateService.canRetryLastAssistant() returns false while
    // streaming (it walks through findRetryAnchor() which has the guard).
    // Mirror that contract in the stub.
    chat.isStreaming = true;
    chat.canRetryLastAssistant = vi.fn().mockReturnValue(false);
    refresh();
    expect(retryButton()?.disabled).toBe(true);
  });

  it('disables retry button when canRetryLastAssistant returns false', () => {
    chat.canRetryLastAssistant = vi.fn().mockReturnValue(false);
    refresh();
    expect(retryButton()?.disabled).toBe(true);
  });

  it('does not invoke retryLastAssistant when retry is disabled', async () => {
    chat.canRetryLastAssistant = vi.fn().mockReturnValue(false);
    fixture.detectChanges();
    // Calling onRetry directly mimics the keyboard shortcut path; the button
    // itself is disabled at the DOM level so a real click would be no-op.
    await component.onRetry();
    expect(chat.retryLastAssistant).not.toHaveBeenCalled();
  });

  it('disables copy button while a copy is in flight', async () => {
    let resolveCopy: (v: boolean) => void = () => {};
    chat.copyMessage = vi.fn().mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveCopy = resolve;
      })
    );
    copyButton().click();
    await Promise.resolve();
    fixture.detectChanges();
    expect(copyButton().disabled).toBe(true);
    resolveCopy(true);
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    // After resolution, busy clears even though "copied" is still showing.
    expect(copyButton().disabled).toBe(false);
  });

  // ── Cleanup ─────────────────────────────────────────────────────

  it('clears the pending copy timer on destroy', async () => {
    copyButton().click();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(copyButton().textContent?.trim()).toBe('✓ copied');
    fixture.destroy();
    // Advancing past the feedback window must not throw or schedule callbacks
    // on a destroyed component (which would crash with "ChangeDetector destroyed").
    vi.advanceTimersByTime(2_000);
  });
});
