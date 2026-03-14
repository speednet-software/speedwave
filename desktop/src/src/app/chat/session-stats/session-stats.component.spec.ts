import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SessionStatsComponent } from './session-stats.component';

describe('SessionStatsComponent', () => {
  let component: SessionStatsComponent;
  let fixture: ComponentFixture<SessionStatsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionStatsComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(SessionStatsComponent);
    component = fixture.componentInstance;
  });

  it('renders nothing when stats is null', () => {
    component.stats = null;
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.session-stats')).toBeNull();
  });

  it('renders cost and total', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0.003,
      total_cost: 0.015,
    };
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('$0.0030');
    expect(el.textContent).toContain('$0.0150');
  });

  it('renders token usage when available', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0.01,
      total_cost: 0.05,
      usage: {
        input_tokens: 500,
        output_tokens: 100,
        cache_read_tokens: 50,
        cache_write_tokens: 30,
      },
    };
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('In: 500');
    expect(el.textContent).toContain('Out: 100');
    expect(el.textContent).toContain('Cache read: 50');
    expect(el.textContent).toContain('Cache write: 30');
  });

  it('does not show cache tokens when not present', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0.01,
      total_cost: 0.05,
      usage: {
        input_tokens: 500,
        output_tokens: 100,
      },
    };
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('Cache read:');
    expect(el.textContent).not.toContain('Cache write:');
  });

  it('shows only cache_read when cache_write is not present', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0.01,
      total_cost: 0.05,
      usage: {
        input_tokens: 500,
        output_tokens: 100,
        cache_read_tokens: 50,
      },
    };
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Cache read: 50');
    expect(el.textContent).not.toContain('Cache write:');
  });
});
