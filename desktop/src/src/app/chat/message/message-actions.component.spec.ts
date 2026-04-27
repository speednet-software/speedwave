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

  function copiedIndicator(): HTMLElement | null {
    return fixture.nativeElement.querySelector(
      '[data-testid="message-copied"]'
    ) as HTMLElement | null;
  }

  function refresh(): void {
    const current = component.entryIndex();
    fixture.componentRef.setInput('entryIndex', current + 1);
    fixture.detectChanges();
    fixture.componentRef.setInput('entryIndex', current);
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

  it('renders copy and retry buttons with ARIA labels by default', () => {
    const copy = copyButton();
    const retry = retryButton();
    expect(copy.getAttribute('aria-label')).toBe('Copy message');
    expect(copy.textContent?.trim()).toBe('copy');
    expect(retry).not.toBeNull();
    expect(retry?.getAttribute('aria-label')).toBe('Retry last response');
    expect(retry?.textContent?.trim()).toBe('retry');
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

  it('shows "✓ copied" indicator alongside copy button for 1.5s after a successful copy, then reverts', async () => {
    copyButton().click();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(copiedIndicator()).not.toBeNull();
    expect(copiedIndicator()?.textContent?.trim()).toBe('✓ copied');
    expect(copyButton().textContent?.trim()).toBe('copy');
    expect(copyButton().getAttribute('aria-label')).toBe('Copied to clipboard');
    vi.advanceTimersByTime(1_499);
    fixture.detectChanges();
    expect(copiedIndicator()).not.toBeNull();
    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(copiedIndicator()).toBeNull();
    expect(copyButton().textContent?.trim()).toBe('copy');
    expect(copyButton().getAttribute('aria-label')).toBe('Copy message');
  });

  it('does NOT show "✓ copied" when copyMessage returns false', async () => {
    chat.copyMessage = vi.fn().mockResolvedValue(false);
    copyButton().click();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(copiedIndicator()).toBeNull();
    expect(copyButton().textContent?.trim()).toBe('copy');
  });

  it('hides retry button when isLast is false', () => {
    fixture.componentRef.setInput('isLast', false);
    fixture.detectChanges();
    expect(retryButton()).toBeNull();
  });

  it('disables retry button when chat.isStreaming is true', () => {
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
    expect(copyButton().disabled).toBe(false);
  });

  it('clears the pending copy timer on destroy', async () => {
    copyButton().click();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(copiedIndicator()).not.toBeNull();
    fixture.destroy();
    vi.advanceTimersByTime(2_000);
  });

  it('does not render any metadata segments (delegated to app-message-metadata)', () => {
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="message-meta"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-tokens"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-cache"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-cost"]')).toBeNull();
  });
});
