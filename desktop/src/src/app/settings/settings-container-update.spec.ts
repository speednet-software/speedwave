import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UpdateSectionComponent } from './update-section/update-section.component';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

describe('UpdateSectionComponent — section visibility', () => {
  let component: UpdateSectionComponent;
  let fixture: ComponentFixture<UpdateSectionComponent>;
  let mockTauri: MockTauriService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();

    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_update_settings':
          return { auto_check: true, check_interval_hours: 24 };
        case 'get_platform':
          return 'darwin';
        default:
          return undefined;
      }
    };

    await TestBed.configureTestingModule({
      imports: [UpdateSectionComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(UpdateSectionComponent);
    component = fixture.componentInstance;
  });

  it('renders the Updates section heading', async () => {
    component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();
    const headings = fixture.nativeElement.querySelectorAll('h2') as NodeListOf<Element>;
    const texts = Array.from(headings).map((h) => h.textContent?.trim());
    expect(texts).toContain('Updates');
  });

  it('does not render a Container Updates section', async () => {
    component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();
    const headings = fixture.nativeElement.querySelectorAll('h2') as NodeListOf<Element>;
    const texts = Array.from(headings).map((h) => h.textContent?.trim());
    expect(texts).not.toContain('Container Updates');
  });
});
