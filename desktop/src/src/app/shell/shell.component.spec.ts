import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterModule } from '@angular/router';
import { ShellComponent } from './shell.component';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

describe('ShellComponent', () => {
  let component: ShellComponent;
  let fixture: ComponentFixture<ShellComponent>;

  beforeEach(async () => {
    const mockTauri = new MockTauriService();

    await TestBed.configureTestingModule({
      imports: [ShellComponent, RouterModule.forRoot([])],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(ShellComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should render nav with Chat, Integrations, Settings', () => {
    const nav = fixture.nativeElement.querySelector('.app-nav');
    const links = Array.from(nav.querySelectorAll('a')) as HTMLAnchorElement[];
    const labels = links.map((a) => a.textContent?.trim());
    expect(labels).toEqual(['Chat', 'Integrations', 'Settings']);
  });

  it('should NOT render a Setup link', () => {
    const nav = fixture.nativeElement.querySelector('.app-nav');
    const links = Array.from(nav.querySelectorAll('a')) as HTMLAnchorElement[];
    const labels = links.map((a) => a.textContent?.trim());
    expect(labels).not.toContain('Setup');
  });

  it('should render update-notification', () => {
    const el = fixture.nativeElement.querySelector('app-update-notification');
    expect(el).toBeTruthy();
  });

  it('should render project-switcher', () => {
    const el = fixture.nativeElement.querySelector('app-project-switcher');
    expect(el).toBeTruthy();
  });

  it('should render router-outlet', () => {
    const el = fixture.nativeElement.querySelector('router-outlet');
    expect(el).toBeTruthy();
  });
});
