import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, beforeEach, it, expect } from 'vitest';
import { ProgressStepsComponent, type SetupStep } from './progress-steps.component';

@Component({
  selector: 'app-host',
  imports: [ProgressStepsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-progress-steps
      [steps]="steps()"
      [error]="error()"
      [etaSeconds]="etaSeconds()"
      [showFooter]="showFooter()"
      [showBackButton]="showBackButton()"
      (retry)="retryCount = retryCount + 1"
      (back)="backCount = backCount + 1"
    />
  `,
})
class HostComponent {
  readonly steps = signal<SetupStep[]>([]);
  readonly error = signal<string | null>(null);
  readonly etaSeconds = signal<number | null>(null);
  readonly showFooter = signal<boolean>(true);
  readonly showBackButton = signal<boolean>(true);
  retryCount = 0;
  backCount = 0;
}

function makeStep(
  id: string,
  status: SetupStep['status'],
  extra: Partial<SetupStep> = {}
): SetupStep {
  return {
    id,
    title: `step ${id}`,
    description: `desc ${id}`,
    status,
    ...extra,
  };
}

describe('ProgressStepsComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
  });

  it('renders one row per step', () => {
    host.steps.set([makeStep('a', 'pending'), makeStep('b', 'pending'), makeStep('c', 'pending')]);
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('[data-testid="setup-step"]');
    expect(rows.length).toBe(3);
  });

  it('renders done/active/error/pending pills correctly', () => {
    host.steps.set([
      makeStep('a', 'done'),
      makeStep('b', 'active'),
      makeStep('c', 'error'),
      makeStep('d', 'pending'),
    ]);
    fixture.detectChanges();
    const pills = fixture.nativeElement.querySelectorAll('[data-testid="step-pill"]');
    // pending step has no pill
    expect(pills.length).toBe(3);
    expect(pills[0].textContent.trim()).toBe('done');
    expect(pills[1].textContent.trim()).toBe('running');
    expect(pills[2].textContent.trim()).toBe('error');
  });

  it('sizes the active-step spinner above the host default so its stroke is not razor-thin', () => {
    // A bare <app-spin-icon> renders at the 14px host default, whose ~1.75px
    // stroke shimmers on WKWebView; the active circle pins it to 16px (h-4 w-4).
    host.steps.set([makeStep('a', 'active')]);
    fixture.detectChanges();
    const spinner = fixture.nativeElement.querySelector('app-spin-icon');
    expect(spinner).toBeTruthy();
    expect(spinner.classList.contains('h-4')).toBe(true);
    expect(spinner.classList.contains('w-4')).toBe(true);
  });

  it('colors the active-step circle with the brand accent to match primary buttons', () => {
    // The spinner stroke is currentColor, inherited from the circle's color.
    host.steps.set([makeStep('a', 'active')]);
    fixture.detectChanges();
    const circle = fixture.nativeElement.querySelector('app-spin-icon').closest('div');
    expect(circle.style.color).toBe('var(--accent)');
    expect(circle.style.borderColor).toBe('var(--accent-dim)');
  });

  it('renders the progress bar only for active steps with progress set', () => {
    host.steps.set([
      makeStep('a', 'active'), // no progress → no bar
      makeStep('b', 'active', { progress: 42 }),
      makeStep('c', 'pending', { progress: 50 }), // pending → no bar
    ]);
    fixture.detectChanges();
    const all = fixture.nativeElement.querySelectorAll('[style]');
    const widthBars = Array.from(all).filter((el) =>
      /width:\s*42%/.test((el as HTMLElement).style.cssText)
    );
    expect(widthBars.length).toBe(1);
  });

  it('shows the footer with "step X of Y" and omits ETA when etaSeconds is null', () => {
    host.steps.set([makeStep('a', 'done'), makeStep('b', 'active')]);
    host.etaSeconds.set(null);
    fixture.detectChanges();
    const footer = fixture.nativeElement.querySelector('[data-testid="setup-progress-summary"]');
    expect(footer.textContent).toContain('step 2 of 2');
    expect(footer.textContent).not.toContain('remaining');
  });

  it('appends "~Ns remaining" to the footer when etaSeconds is set', () => {
    host.steps.set([makeStep('a', 'active'), makeStep('b', 'pending')]);
    host.etaSeconds.set(45);
    fixture.detectChanges();
    const footer = fixture.nativeElement.querySelector('[data-testid="setup-progress-summary"]');
    expect(footer.textContent).toMatch(/~45s remaining/);
  });

  it('hides the footer entirely when showFooter is false', () => {
    host.steps.set([makeStep('a', 'active')]);
    host.showFooter.set(false);
    fixture.detectChanges();
    const footer = fixture.nativeElement.querySelector('[data-testid="setup-footer"]');
    expect(footer).toBeNull();
  });

  it('shows the error banner with retry/back buttons when error is set', () => {
    host.steps.set([makeStep('a', 'error')]);
    host.error.set('something broke');
    fixture.detectChanges();
    const errBanner = fixture.nativeElement.querySelector('[data-testid="setup-error"]');
    expect(errBanner.textContent).toContain('something broke');
    const retryBtn = fixture.nativeElement.querySelector('[data-testid="setup-retry-btn"]');
    const backBtn = fixture.nativeElement.querySelector('[data-testid="setup-back-btn"]');
    expect(retryBtn).not.toBeNull();
    expect(backBtn).not.toBeNull();
  });

  it('hides the back button when showBackButton is false', () => {
    host.steps.set([makeStep('a', 'error')]);
    host.error.set('broke');
    host.showBackButton.set(false);
    fixture.detectChanges();
    const retryBtn = fixture.nativeElement.querySelector('[data-testid="setup-retry-btn"]');
    const backBtn = fixture.nativeElement.querySelector('[data-testid="setup-back-btn"]');
    expect(retryBtn).not.toBeNull();
    expect(backBtn).toBeNull();
  });

  it('emits (retry) when the retry button is clicked', () => {
    host.steps.set([makeStep('a', 'error')]);
    host.error.set('broke');
    fixture.detectChanges();
    const retryBtn = fixture.nativeElement.querySelector(
      '[data-testid="setup-retry-btn"]'
    ) as HTMLButtonElement;
    retryBtn.click();
    expect(host.retryCount).toBe(1);
  });

  it('emits (back) when the back button is clicked', () => {
    host.steps.set([makeStep('a', 'error')]);
    host.error.set('broke');
    fixture.detectChanges();
    const backBtn = fixture.nativeElement.querySelector(
      '[data-testid="setup-back-btn"]'
    ) as HTMLButtonElement;
    backBtn.click();
    expect(host.backCount).toBe(1);
  });

  it('renders without crashing with an empty step list', () => {
    host.steps.set([]);
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('[data-testid="setup-step"]');
    expect(rows.length).toBe(0);
    const footer = fixture.nativeElement.querySelector('[data-testid="setup-progress-summary"]');
    expect(footer.textContent).toContain('step 0 of 0');
  });

  it('reactively re-renders when the steps signal updates', () => {
    host.steps.set([makeStep('a', 'pending')]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('[data-testid="setup-step"]').length).toBe(1);
    host.steps.set([makeStep('a', 'pending'), makeStep('b', 'active')]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('[data-testid="setup-step"]').length).toBe(2);
  });
});
