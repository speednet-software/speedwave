import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DiffViewComponent, computeLineDiff } from './diff-view.component';

describe('computeLineDiff', () => {
  it('emits context row for identical single-line inputs', () => {
    expect(computeLineDiff('same', 'same')).toEqual([{ kind: 'ctx', text: 'same' }]);
  });

  it('emits a single add for new text with empty old', () => {
    expect(computeLineDiff('', 'hello')).toEqual([{ kind: 'add', text: 'hello' }]);
  });

  it('emits a single remove for deletion to empty', () => {
    expect(computeLineDiff('hello', '')).toEqual([{ kind: 'remove', text: 'hello' }]);
  });

  it('emits no rows when both inputs are empty', () => {
    expect(computeLineDiff('', '')).toEqual([]);
  });

  it('preserves unchanged lines as context and reports only diffs', () => {
    const result = computeLineDiff('a\nb\nc', 'a\nX\nc');
    expect(result).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'remove', text: 'b' },
      { kind: 'add', text: 'X' },
      { kind: 'ctx', text: 'c' },
    ]);
  });

  it('handles pure-addition in middle of common prefix/suffix', () => {
    const result = computeLineDiff('a\nc', 'a\nb\nc');
    expect(result).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'add', text: 'b' },
      { kind: 'ctx', text: 'c' },
    ]);
  });

  it('handles pure-removal between common lines', () => {
    const result = computeLineDiff('a\nb\nc', 'a\nc');
    expect(result).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'remove', text: 'b' },
      { kind: 'ctx', text: 'c' },
    ]);
  });

  it('strips trailing CR so CRLF and LF inputs compare equal', () => {
    // Files saved on Windows arrive as CRLF; the same content from a Unix
    // tool is LF-only. Without CRLF stripping every line would diff.
    const result = computeLineDiff('a\r\nb\r\nc', 'a\nb\nc');
    expect(result).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'ctx', text: 'b' },
      { kind: 'ctx', text: 'c' },
    ]);
  });
});

describe('DiffViewComponent', () => {
  let fixture: ComponentFixture<DiffViewComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DiffViewComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(DiffViewComponent);
  });

  function setInputs(oldString: string, newString: string, truncateLines?: number): void {
    fixture.componentRef.setInput('oldString', oldString);
    fixture.componentRef.setInput('newString', newString);
    if (truncateLines !== undefined) {
      fixture.componentRef.setInput('truncateLines', truncateLines);
    }
    fixture.detectChanges();
  }

  it('renders 3 added, 2 removed, 5 context lines with correct test-ids', () => {
    const ctx = ['same-1', 'same-2', 'same-3', 'same-4', 'same-5'].join('\n');
    setInputs(`${ctx}\nold-1\nold-2`, `${ctx}\nnew-1\nnew-2\nnew-3`);

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('[data-testid="diff-ctx"]').length).toBe(5);
    expect(el.querySelectorAll('[data-testid="diff-remove"]').length).toBe(2);
    expect(el.querySelectorAll('[data-testid="diff-add"]').length).toBe(3);
  });

  it('renders only the container when both inputs are empty', () => {
    setInputs('', '');

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="diff-container"]')).not.toBeNull();
    expect(el.querySelectorAll('[data-testid="diff-add"]').length).toBe(0);
    expect(el.querySelectorAll('[data-testid="diff-remove"]').length).toBe(0);
    expect(el.querySelectorAll('[data-testid="diff-ctx"]').length).toBe(0);
  });

  it('renders only context rows when inputs are identical', () => {
    setInputs('a\nb\nc', 'a\nb\nc');

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('[data-testid="diff-ctx"]').length).toBe(3);
    expect(el.querySelectorAll('[data-testid="diff-add"]').length).toBe(0);
    expect(el.querySelectorAll('[data-testid="diff-remove"]').length).toBe(0);
  });

  it('renders only additions when oldString is empty', () => {
    setInputs('', 'x\ny\nz');

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('[data-testid="diff-add"]').length).toBe(3);
    expect(el.querySelectorAll('[data-testid="diff-remove"]').length).toBe(0);
    expect(el.querySelectorAll('[data-testid="diff-ctx"]').length).toBe(0);
  });

  it('renders only removals when newString is empty', () => {
    setInputs('x\ny\nz', '');

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('[data-testid="diff-remove"]').length).toBe(3);
    expect(el.querySelectorAll('[data-testid="diff-add"]').length).toBe(0);
    expect(el.querySelectorAll('[data-testid="diff-ctx"]').length).toBe(0);
  });

  it('truncates diffs longer than truncateLines and shows omitted marker', () => {
    setInputs(
      Array.from({ length: 50 }, (_, i) => `old-${i}`).join('\n'),
      Array.from({ length: 50 }, (_, i) => `new-${i}`).join('\n'),
      10
    );

    const el = fixture.nativeElement as HTMLElement;
    const omitted = el.querySelector('[data-testid="diff-omitted"]');
    expect(omitted).not.toBeNull();
    expect(omitted?.textContent).toContain('lines omitted');

    const expandBtn = el.querySelector('[data-testid="diff-expand"]');
    expect(expandBtn).not.toBeNull();
  });

  it('does not show omitted marker or expand button for short diffs', () => {
    setInputs('a\nb', 'x\ny', 20);

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="diff-omitted"]')).toBeNull();
    expect(el.querySelector('[data-testid="diff-expand"]')).toBeNull();
  });

  it('expand button reveals full diff and hides the omitted marker', () => {
    setInputs(
      Array.from({ length: 30 }, (_, i) => `old-${i}`).join('\n'),
      Array.from({ length: 30 }, (_, i) => `new-${i}`).join('\n'),
      10
    );

    const el = fixture.nativeElement as HTMLElement;
    const expandBtn = el.querySelector('[data-testid="diff-expand"]') as HTMLButtonElement | null;
    expect(expandBtn).not.toBeNull();
    expandBtn?.click();
    fixture.detectChanges();

    expect(el.querySelector('[data-testid="diff-omitted"]')).toBeNull();
    expect(el.querySelector('[data-testid="diff-expand"]')).toBeNull();
    // All 60 lines should now render (30 removes + 30 adds).
    const total =
      el.querySelectorAll('[data-testid="diff-add"]').length +
      el.querySelectorAll('[data-testid="diff-remove"]').length +
      el.querySelectorAll('[data-testid="diff-ctx"]').length;
    expect(total).toBe(60);
  });

  it('applies whitespace-pre on each line, not the container', () => {
    setInputs('a b c', 'x y z');

    const el = fixture.nativeElement as HTMLElement;
    const container = el.querySelector('[data-testid="diff-container"]');
    expect(container?.className).not.toContain('whitespace-pre');

    const add = el.querySelector('[data-testid="diff-add"]');
    expect(add?.className).toContain('whitespace-pre');
    const remove = el.querySelector('[data-testid="diff-remove"]');
    expect(remove?.className).toContain('whitespace-pre');
  });

  it('does NOT truncate when diff line count equals truncateLines exactly', () => {
    // 6 total diff lines (3 removals + 3 additions). truncateLines = 6 — must NOT truncate.
    setInputs('a\nb\nc', 'x\ny\nz', 6);

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="diff-omitted"]')).toBeNull();
  });

  it('truncates when diff line count exceeds truncateLines', () => {
    // 8 total diff lines (4 removals + 4 additions) > truncateLines 6 — must truncate.
    setInputs('a\nb\nc\nd', 'w\nx\ny\nz', 6);

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="diff-omitted"]')).not.toBeNull();
  });

  it('resets the user expand toggle when oldString or newString changes', () => {
    // Truncate with a long diff, click expand to reveal full, then swap inputs:
    // the new diff must start collapsed again per the OnChanges contract preserved
    // by the effect.
    setInputs(
      Array.from({ length: 30 }, (_, i) => `old-${i}`).join('\n'),
      Array.from({ length: 30 }, (_, i) => `new-${i}`).join('\n'),
      10
    );
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('[data-testid="diff-expand"]') as HTMLButtonElement | null)?.click();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="diff-omitted"]')).toBeNull();

    // Swap to a fresh diff that is again above the threshold.
    setInputs(
      Array.from({ length: 30 }, (_, i) => `old2-${i}`).join('\n'),
      Array.from({ length: 30 }, (_, i) => `new2-${i}`).join('\n'),
      10
    );
    expect(el.querySelector('[data-testid="diff-omitted"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="diff-expand"]')).not.toBeNull();
  });
});
