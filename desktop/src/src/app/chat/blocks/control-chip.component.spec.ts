import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ControlChipComponent } from './control-chip.component';

describe('ControlChipComponent', () => {
  let fixture: ComponentFixture<ControlChipComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ControlChipComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ControlChipComponent);
  });

  it('renders the model command as "model -> <argument>"', () => {
    fixture.componentRef.setInput('command', 'model');
    fixture.componentRef.setInput('argument', 'claude-sonnet-5');
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const chip = el.querySelector('[data-testid="control-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent?.trim()).toBe('model -> claude-sonnet-5');
  });

  it('renders the effort command as "effort -> <argument>"', () => {
    fixture.componentRef.setInput('command', 'effort');
    fixture.componentRef.setInput('argument', 'high');
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const chip = el.querySelector('[data-testid="control-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent?.trim()).toBe('effort -> high');
  });

  it('exposes the command as a data attribute for styling/testing hooks', () => {
    fixture.componentRef.setInput('command', 'model');
    fixture.componentRef.setInput('argument', 'claude-opus-4-8');
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const chip = el.querySelector('[data-testid="control-chip"]');
    expect(chip?.getAttribute('data-command')).toBe('model');
  });
});
