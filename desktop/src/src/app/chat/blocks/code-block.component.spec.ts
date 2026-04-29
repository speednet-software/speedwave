import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Clipboard } from '@angular/cdk/clipboard';
import { CodeBlockComponent } from './code-block.component';

describe('CodeBlockComponent', () => {
  let fixture: ComponentFixture<CodeBlockComponent>;
  let component: CodeBlockComponent;
  let copySpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CodeBlockComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(CodeBlockComponent);
    component = fixture.componentInstance;

    copySpy = vi.fn().mockReturnValue(true);
    const cdkClipboard = TestBed.inject(Clipboard);
    cdkClipboard.copy = copySpy as unknown as typeof cdkClipboard.copy;

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the code content verbatim inside <pre><code>', () => {
    fixture.componentRef.setInput('code', 'const x = 1;\nconst y = 2;');
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector('[data-testid="code-block-body"]');
    expect(body).not.toBeNull();
    const codeEl = body.querySelector('code');
    expect(codeEl?.textContent).toBe('const x = 1;\nconst y = 2;');
  });

  it('applies the rounded ring-1 wrapper classes from the design system', () => {
    fixture.componentRef.setInput('code', 'x');
    fixture.detectChanges();

    const wrapper = fixture.nativeElement.querySelector(
      '[data-testid="code-block"]'
    ) as HTMLElement;
    expect(wrapper.className).toContain('overflow-hidden');
    expect(wrapper.className).toContain('rounded');
    expect(wrapper.className).toContain('ring-1');
    expect(wrapper.className).toContain('ring-[var(--line)]');
    expect(wrapper.className).toContain('bg-[var(--bg-1)]');
    // The wrapper itself must not carry a border-b (would clash with the ring).
    expect(wrapper.className).not.toContain('border-b');
  });

  it('renders the filename header when filename input is set', () => {
    fixture.componentRef.setInput('code', 'x');
    fixture.componentRef.setInput('filename', 'containers/compose.template.yml');
    fixture.detectChanges();

    const header = fixture.nativeElement.querySelector('[data-testid="code-block-header"]');
    expect(header).not.toBeNull();
    expect(header.textContent).toContain('containers/compose.template.yml');
    const pathSpan = header.querySelector('span');
    expect(pathSpan?.className).toContain('text-[var(--teal)]');
    expect(pathSpan?.className).toContain('mono');
    // Header must not carry a border-b (would create corner artifacts inside rounded ring).
    expect((header as HTMLElement).className).not.toContain('border-b');
  });

  it('omits the filename span when filename is empty but keeps the copy row', () => {
    fixture.componentRef.setInput('code', 'x');
    fixture.detectChanges();

    const header = fixture.nativeElement.querySelector(
      '[data-testid="code-block-header"]'
    ) as HTMLElement | null;
    expect(header).not.toBeNull();
    // The teal filename span is identified by its mono+text-[var(--teal)] classes; when
    // no filename is set, no span carrying the filename text is rendered.
    expect(header?.querySelector('span.mono')).toBeNull();
    expect(header?.querySelector('[data-testid="code-block-copy"]')).not.toBeNull();
  });

  it('omits the entire header row when both filename and copyable are off', () => {
    fixture.componentRef.setInput('code', 'x');
    fixture.componentRef.setInput('copyable', false);
    fixture.detectChanges();

    const header = fixture.nativeElement.querySelector('[data-testid="code-block-header"]');
    expect(header).toBeNull();
  });

  it('renders the copy button with aria-label="Copy code"', () => {
    fixture.componentRef.setInput('code', 'hello');
    fixture.componentRef.setInput('filename', 'file.txt');
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('[data-testid="code-block-copy"]');
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('Copy code');
    expect(btn.getAttribute('type')).toBe('button');
  });

  it('hides the copy button when copyable is false', () => {
    fixture.componentRef.setInput('code', 'x');
    fixture.componentRef.setInput('filename', 'f.txt');
    fixture.componentRef.setInput('copyable', false);
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('[data-testid="code-block-copy"]');
    expect(btn).toBeNull();
  });

  it('shows a standalone copy button even without a filename', () => {
    fixture.componentRef.setInput('code', 'x');
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('[data-testid="code-block-copy"]');
    expect(btn).not.toBeNull();
  });

  it('calls Clipboard.copy on copy and toggles justCopied', () => {
    fixture.componentRef.setInput('code', 'copy me');
    fixture.detectChanges();

    expect(component.justCopied()).toBe(false);

    component.copy();
    fixture.detectChanges();

    expect(copySpy).toHaveBeenCalledOnce();
    expect(copySpy).toHaveBeenCalledWith('copy me');
    expect(component.justCopied()).toBe(true);

    const confirmation = fixture.nativeElement.querySelector('[data-testid="code-block-copied"]');
    expect(confirmation?.textContent).toContain('copied');

    // After 1.5s the confirmation disappears.
    vi.advanceTimersByTime(1500);
    fixture.detectChanges();
    expect(component.justCopied()).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="code-block-copied"]')).toBeNull();
  });

  it('handles an empty code input without error', () => {
    fixture.componentRef.setInput('code', '');
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector('[data-testid="code-block-body"]');
    expect(body).not.toBeNull();
    expect(body.querySelector('code')?.textContent ?? '').toBe('');
  });

  it('applies whitespace-pre and overflow-x-auto to the <pre> body', () => {
    fixture.componentRef.setInput('code', 'x');
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector(
      '[data-testid="code-block-body"]'
    ) as HTMLElement;
    expect(body.className).toContain('whitespace-pre');
    expect(body.className).toContain('overflow-x-auto');
    expect(body.className).toContain('mono');
  });

  it('logs clipboard errors and leaves justCopied false', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    copySpy.mockReturnValueOnce(false);
    fixture.componentRef.setInput('code', 'blocked');
    fixture.detectChanges();

    component.copy();
    fixture.detectChanges();

    expect(copySpy).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalledOnce();
    expect(component.justCopied()).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="code-block-copied"]')).toBeNull();
    errSpy.mockRestore();
  });

  it('cancels the copied-confirmation timer when the component is destroyed', () => {
    fixture.componentRef.setInput('code', 'x');
    fixture.detectChanges();

    component.copy();
    expect(component.justCopied()).toBe(true);

    fixture.destroy();
    // Advancing past the timeout must not re-enter the setter on a destroyed
    // component — the ngOnDestroy hook cleared the timer.
    vi.advanceTimersByTime(1500);
    expect(component.justCopied()).toBe(true);
  });
});
