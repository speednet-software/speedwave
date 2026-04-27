import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MessageMetadataComponent } from './message-metadata.component';
import type { ChatMessage } from '../../models/chat';

function baseAssistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    role: 'assistant',
    blocks: [{ type: 'text', content: 'hello' }],
    timestamp: 0,
    ...overrides,
  };
}

describe('MessageMetadataComponent', () => {
  let fixture: ComponentFixture<MessageMetadataComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MessageMetadataComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(MessageMetadataComponent);
  });

  function setEntry(entry: ChatMessage, edited = false): void {
    fixture.componentRef.setInput('entry', entry);
    fixture.componentRef.setInput('precedingEdited', edited);
    fixture.detectChanges();
  }

  it('renders nothing of substance when meta is absent', () => {
    setEntry(baseAssistant());

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="message-metadata"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="meta-model"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-edited"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-tokens"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-cache"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-cost"]')).toBeNull();
  });

  it('renders all segments when full meta is present', () => {
    setEntry(
      baseAssistant({
        meta: {
          model: 'opus-4.7',
          usage: {
            input_tokens: 243,
            output_tokens: 1000,
            cache_read_tokens: 4012,
            cache_write_tokens: 0,
          },
          cost: 0.018,
        },
      }),
      true
    );

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-model"]')?.textContent).toBe('opus-4.7');
    expect(el.querySelector('[data-testid="meta-edited"]')?.textContent).toContain('edited');
    expect(el.querySelector('[data-testid="meta-tokens"]')?.textContent).toContain('1,243 tok');
    expect(el.querySelector('[data-testid="meta-cache"]')?.textContent).toContain('cache: 4,012');
    expect(el.querySelector('[data-testid="meta-cost"]')?.textContent).toContain('$0.018');
  });

  it('hides model segment when model is absent but renders other segments', () => {
    setEntry(
      baseAssistant({
        meta: {
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          },
          cost: 0.001,
        },
      })
    );

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-model"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-tokens"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="meta-cost"]')).not.toBeNull();
  });

  it('hides tokens segment when usage is absent', () => {
    setEntry(
      baseAssistant({
        meta: { model: 'opus-4.7', cost: 0.01 },
      })
    );

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-tokens"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-cache"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-model"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="meta-cost"]')).not.toBeNull();
  });

  it('hides cache segment when cache_read_tokens is 0', () => {
    setEntry(
      baseAssistant({
        meta: {
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          },
        },
      })
    );

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-cache"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-tokens"]')).not.toBeNull();
  });

  it('hides edited chip when precedingEdited is false', () => {
    setEntry(
      baseAssistant({
        meta: { model: 'opus-4.7' },
      }),
      false
    );

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-edited"]')).toBeNull();
  });

  it('hides cost segment when cost is undefined', () => {
    setEntry(
      baseAssistant({
        meta: {
          model: 'opus-4.7',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          },
        },
      })
    );

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-cost"]')).toBeNull();
  });

  it('renders cost zero as $0.000 (not hidden when cost is 0)', () => {
    setEntry(baseAssistant({ meta: { cost: 0 } }));

    const el = fixture.nativeElement as HTMLElement;
    const cost = el.querySelector('[data-testid="meta-cost"]');
    expect(cost).not.toBeNull();
    expect(cost?.textContent).toContain('$0.000');
  });

  it('formats cost to exactly 3 decimal places', () => {
    setEntry(baseAssistant({ meta: { cost: 0.12345 } }));

    const el = fixture.nativeElement as HTMLElement;
    const cost = el.querySelector('[data-testid="meta-cost"]')?.textContent;
    expect(cost).toContain('$0.123');
    expect(cost).not.toContain('$0.12345');
  });

  it('rounds cost correctly to 3 decimals', () => {
    setEntry(baseAssistant({ meta: { cost: 0.1235 } }));

    const el = fixture.nativeElement as HTMLElement;
    const cost = el.querySelector('[data-testid="meta-cost"]')?.textContent;
    expect(cost).toMatch(/\$0\.12[34]/);
  });

  it('formats large token counts with thousands separators', () => {
    setEntry(
      baseAssistant({
        meta: {
          usage: {
            input_tokens: 500_000,
            output_tokens: 750_000,
            cache_read_tokens: 1_000_000,
            cache_write_tokens: 0,
          },
        },
      })
    );

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-tokens"]')?.textContent).toContain('1,250,000 tok');
    expect(el.querySelector('[data-testid="meta-cache"]')?.textContent).toContain(
      'cache: 1,000,000'
    );
  });

  it('sets aria-label on tokens span for screen readers', () => {
    setEntry(
      baseAssistant({
        meta: {
          usage: {
            input_tokens: 243,
            output_tokens: 1_000,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          },
        },
      })
    );

    const el = fixture.nativeElement as HTMLElement;
    const tokens = el.querySelector('[data-testid="meta-tokens"]');
    expect(tokens?.getAttribute('aria-label')).toBe('1243 tokens');
  });

  it('sums input and output tokens (excludes cache) in the displayed count', () => {
    setEntry(
      baseAssistant({
        meta: {
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 9999,
            cache_write_tokens: 8888,
          },
        },
      })
    );

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-tokens"]')?.textContent).toContain('150 tok');
  });

  it('renders nothing for undefined cache_read_tokens (hides cache segment)', () => {
    setEntry(
      baseAssistant({
        meta: {
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: undefined as unknown as number,
            cache_write_tokens: 0,
          },
        },
      })
    );

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-cache"]')).toBeNull();
  });

  it('strips claude- prefix and rewrites version dashes for raw backend ids (opus)', () => {
    setEntry(
      baseAssistant({
        meta: {
          model: 'claude-opus-4-7',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          },
        },
      })
    );

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-model"]')?.textContent?.trim()).toBe('opus-4.7');
  });

  it('handles haiku version transformation', () => {
    setEntry(
      baseAssistant({
        meta: {
          model: 'claude-haiku-4-5',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          },
        },
      })
    );

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-model"]')?.textContent?.trim()).toBe('haiku-4.5');
  });

  it('handles sonnet version transformation', () => {
    setEntry(baseAssistant({ meta: { model: 'claude-sonnet-4-6' } }));

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-model"]')?.textContent?.trim()).toBe('sonnet-4.6');
  });

  it('renders an already-prettified id verbatim (no double transformation)', () => {
    setEntry(baseAssistant({ meta: { model: 'opus-4.7' } }));

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-model"]')?.textContent?.trim()).toBe('opus-4.7');
  });
});
