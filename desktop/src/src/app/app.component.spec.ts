import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CSP_NONCE } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterModule } from '@angular/router';
import { AppComponent } from './app.component';

describe('AppComponent', () => {
  let component: AppComponent;
  let fixture: ComponentFixture<AppComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent, RouterModule.forRoot([])],
    }).compileComponents();

    fixture = TestBed.createComponent(AppComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should render router-outlet', () => {
    const el = fixture.nativeElement.querySelector('router-outlet');
    expect(el).toBeTruthy();
  });

  it('should not render shell elements', () => {
    expect(fixture.nativeElement.querySelector('.app-header')).toBeFalsy();
    expect(fixture.nativeElement.querySelector('.app-nav')).toBeFalsy();
    expect(fixture.nativeElement.querySelector('app-project-switcher')).toBeFalsy();
    expect(fixture.nativeElement.querySelector('app-update-notification')).toBeFalsy();
  });
});

describe('CSP nonce bridging', () => {
  let styleEl: HTMLStyleElement;

  afterEach(() => {
    styleEl?.remove();
  });

  it('should provide CSP_NONCE when boot-overlay style has a nonce', async () => {
    styleEl = document.createElement('style');
    styleEl.id = 'boot-overlay-style';
    styleEl.setAttribute('nonce', 'tauri-test-nonce-123');
    document.head.prepend(styleEl);

    const nonce = document.getElementById('boot-overlay-style')?.nonce || '';

    await TestBed.configureTestingModule({
      imports: [AppComponent, RouterModule.forRoot([])],
      providers: [{ provide: CSP_NONCE, useValue: nonce }],
    }).compileComponents();

    expect(TestBed.inject(CSP_NONCE)).toBe('tauri-test-nonce-123');
  });

  it('should not provide CSP_NONCE when boot-overlay style is absent', async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent, RouterModule.forRoot([])],
    }).compileComponents();

    const nonce = TestBed.inject(CSP_NONCE, { optional: true } as never);
    expect(nonce).toBeNull();
  });
});
