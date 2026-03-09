import { describe, it, expect, beforeEach } from 'vitest';
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
