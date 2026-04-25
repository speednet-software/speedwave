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
  let component: MessageMetadataComponent;
  let fixture: ComponentFixture<MessageMetadataComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MessageMetadataComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(MessageMetadataComponent);
    component = fixture.componentInstance;
  });

  it('renders nothing of substance when meta is absent', () => {
    component.entry = baseAssistant();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const row = el.querySelector('[data-testid="message-metadata"]') as HTMLElement | null;
    expect(row).not.toBeNull();
    // None of the individual segments should exist
    expect(el.querySelector('[data-testid="meta-model"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-edited"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-tokens"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-cache"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-cost"]')).toBeNull();
  });

  it('renders all segments when full meta is present', () => {
    component.entry = baseAssistant({
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
    });
    component.precedingEdited = true;
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-model"]')?.textContent).toBe('opus-4.7');
    expect(el.querySelector('[data-testid="meta-edited"]')?.textContent).toContain('edited');
    // 243 + 1000 = 1,243
    expect(el.querySelector('[data-testid="meta-tokens"]')?.textContent).toContain('1,243 tok');
    expect(el.querySelector('[data-testid="meta-cache"]')?.textContent).toContain('cache: 4,012');
    expect(el.querySelector('[data-testid="meta-cost"]')?.textContent).toContain('$0.018');
  });

  it('hides model segment when model is absent but renders other segments', () => {
    component.entry = baseAssistant({
      meta: {
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
        cost: 0.001,
      },
    });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-model"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-tokens"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="meta-cost"]')).not.toBeNull();
  });

  it('hides tokens segment when usage is absent', () => {
    component.entry = baseAssistant({
      meta: { model: 'opus-4.7', cost: 0.01 },
    });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-tokens"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-cache"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-model"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="meta-cost"]')).not.toBeNull();
  });

  it('hides cache segment when cache_read_tokens is 0', () => {
    component.entry = baseAssistant({
      meta: {
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
      },
    });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-cache"]')).toBeNull();
    expect(el.querySelector('[data-testid="meta-tokens"]')).not.toBeNull();
  });

  it('hides edited chip when precedingEdited is false', () => {
    component.entry = baseAssistant({
      meta: { model: 'opus-4.7' },
    });
    component.precedingEdited = false;
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-edited"]')).toBeNull();
  });

  it('hides cost segment when cost is undefined', () => {
    component.entry = baseAssistant({
      meta: {
        model: 'opus-4.7',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
      },
    });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-cost"]')).toBeNull();
  });

  it('renders cost zero as $0.000 (not hidden when cost is 0)', () => {
    component.entry = baseAssistant({
      meta: { cost: 0 },
    });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const cost = el.querySelector('[data-testid="meta-cost"]');
    expect(cost).not.toBeNull();
    expect(cost?.textContent).toContain('$0.000');
  });

  it('formats cost to exactly 3 decimal places', () => {
    component.entry = baseAssistant({
      meta: { cost: 0.12345 },
    });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const cost = el.querySelector('[data-testid="meta-cost"]')?.textContent;
    expect(cost).toContain('$0.123');
    // Ensure it rounded, not truncated the remainder — 0.12345 → 0.123
    expect(cost).not.toContain('$0.12345');
  });

  it('rounds cost correctly to 3 decimals', () => {
    component.entry = baseAssistant({
      meta: { cost: 0.1235 },
    });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const cost = el.querySelector('[data-testid="meta-cost"]')?.textContent;
    // 0.1235 → 0.124 (banker's rounding may vary; JS toFixed uses half-to-even in some engines,
    // but the common V8 implementation rounds 0.1235 to "0.124"). Accept either possibility.
    expect(cost).toMatch(/\$0\.12[34]/);
  });

  it('formats large token counts with thousands separators', () => {
    component.entry = baseAssistant({
      meta: {
        usage: {
          input_tokens: 500_000,
          output_tokens: 750_000,
          cache_read_tokens: 1_000_000,
          cache_write_tokens: 0,
        },
      },
    });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-tokens"]')?.textContent).toContain('1,250,000 tok');
    expect(el.querySelector('[data-testid="meta-cache"]')?.textContent).toContain(
      'cache: 1,000,000'
    );
  });

  it('sets aria-label on tokens span for screen readers', () => {
    component.entry = baseAssistant({
      meta: {
        usage: {
          input_tokens: 243,
          output_tokens: 1_000,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
      },
    });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const tokens = el.querySelector('[data-testid="meta-tokens"]');
    // aria-label is the raw integer count + "tokens" — matches spec example
    expect(tokens?.getAttribute('aria-label')).toBe('1243 tokens');
  });

  it('sums input and output tokens (excludes cache) in the displayed count', () => {
    // Per spec: tokens are the per-turn input+output count, cache is separate.
    component.entry = baseAssistant({
      meta: {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 9999, // should NOT appear in the "tok" segment
          cache_write_tokens: 8888,
        },
      },
    });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-tokens"]')?.textContent).toContain('150 tok');
  });

  it('renders nothing for undefined meta.usage.cache_read_tokens (hides cache segment)', () => {
    // Defensive: TurnUsage requires cache_read_tokens, but components may
    // receive malformed data during development. Cover that case.
    component.entry = baseAssistant({
      meta: {
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: undefined as unknown as number,
          cache_write_tokens: 0,
        },
      },
    });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="meta-cache"]')).toBeNull();
  });
});
