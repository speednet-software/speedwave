import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ExperimentalSectionComponent } from './experimental-section.component';
import { FeatureFlagsService } from '../../services/feature-flags.service';
import { FakeFeatureFlagsService } from '../../testing/fake-feature-flags.service';

describe('ExperimentalSectionComponent', () => {
  let fixture: ComponentFixture<ExperimentalSectionComponent>;
  let flags: FakeFeatureFlagsService;
  let errors: string[];

  function render(): HTMLElement {
    fixture = TestBed.createComponent(ExperimentalSectionComponent);
    fixture.componentInstance.errorOccurred.subscribe((m) => errors.push(m));
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function box(el: HTMLElement, flag: string): HTMLInputElement {
    return el.querySelector(`[data-testid="experimental-${flag}-toggle"]`) as HTMLInputElement;
  }

  async function flip(input: HTMLInputElement, on: boolean): Promise<void> {
    input.checked = on;
    input.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    flags = new FakeFeatureFlagsService();
    errors = [];
    await TestBed.configureTestingModule({
      imports: [ExperimentalSectionComponent],
      providers: [{ provide: FeatureFlagsService, useValue: flags }],
    }).compileComponents();
  });

  it('names each flag and says what it shows', () => {
    const text = render().textContent ?? '';
    expect(text).toContain('Experimental features');
    expect(text).toContain('Office integration');
    expect(text).toContain('Shows Office in Integrations.');
    expect(text).toContain('Telemetry settings');
    expect(text).toContain('Shows the Telemetry section.');
  });

  it('shows both switches off while every flag is off', () => {
    const el = render();
    expect(box(el, 'office').checked).toBe(false);
    expect(box(el, 'telemetry_settings').checked).toBe(false);
  });

  it('shows the stored state of each flag', () => {
    flags.setFlag('telemetry_settings', true);
    const el = render();
    expect(box(el, 'office').checked).toBe(false);
    expect(box(el, 'telemetry_settings').checked).toBe(true);
  });

  it('saves only the flipped flag', async () => {
    const el = render();

    await flip(box(el, 'office'), true);

    expect(flags.set).toHaveBeenCalledTimes(1);
    expect(flags.set).toHaveBeenCalledWith('office', true);
    expect(flags.enabled('office')).toBe(true);
    expect(flags.enabled('telemetry_settings')).toBe(false);
  });

  it('turns a flag off again', async () => {
    flags.setFlag('office', true);
    const el = render();

    await flip(box(el, 'office'), false);

    expect(flags.set).toHaveBeenCalledWith('office', false);
    expect(flags.enabled('office')).toBe(false);
  });

  it('reports a failed save and puts the switch back', async () => {
    flags.set.mockRejectedValueOnce(new Error('disk full'));
    const el = render();

    await flip(box(el, 'office'), true);

    expect(errors).toEqual(['disk full']);
    expect(box(el, 'office').checked).toBe(false);
    expect(flags.enabled('office')).toBe(false);
  });
});
