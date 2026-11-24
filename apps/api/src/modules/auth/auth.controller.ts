import { Body, Controller, Get, HttpCode, Param, Post, Put, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import {
  adminLoginSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  mfaTokenSchema,
  mfaVerifySchema,
  otpRequestSchema,
  otpVerifySchema,
  passwordLoginSchema,
  REFRESH_COOKIE,
  resetPasswordSchema,
  signupSchema,
  type AuthStepResponse,
  type MfaEnrollmentResponse,
  type OtpChallengeResponse,
  type SessionUser,
} from '@bijliwala/contracts';
import { actorFromUser, type AuditContext } from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { CurrentUser, Public, RequirePermissions } from '../../core/auth/decorators';
import { RateLimit } from '../../core/auth/rate-limit';
import { AppConfig } from '../../core/config/app-config';
import { ReqContext } from '../../core/http/request-context';
import { ApiZodBody, createZodDto } from '../../core/http/zod';
import { AuthService, type SignInResult } from './auth.service';

class OtpRequestDto extends createZodDto(otpRequestSchema) {}
class OtpVerifyDto extends createZodDto(otpVerifySchema) {}
class SignupDto extends createZodDto(signupSchema) {}
class AdminLoginDto extends createZodDto(adminLoginSchema) {}
class PasswordLoginDto extends createZodDto(passwordLoginSchema) {}
class MfaTokenDto extends createZodDto(mfaTokenSchema) {}
class MfaVerifyDto extends createZodDto(mfaVerifySchema) {}
class ForgotPasswordDto extends createZodDto(forgotPasswordSchema) {}
class ResetPasswordDto extends createZodDto(resetPasswordSchema) {}
class ChangePasswordDto extends createZodDto(changePasswordSchema) {}

/** Extracts the mobile number from an OTP request body for per-number rate limiting. */
const byMobile = (req: Request): string | undefined => {
  const mobile = (req.body as { mobile?: unknown } | undefined)?.mobile;
  return typeof mobile === 'string' ? `mobile:${mobile}` : undefined;
};

export const REFRESH_COOKIE_PATH = '/api/v1/auth';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      maxAge: this.config.env.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
    };
  }

  /** Puts the refresh token in the HttpOnly cookie; it is never part of a response body. */
  private finish(res: Response, result: SignInResult): AuthStepResponse {
    if (result.refreshToken) res.cookie(REFRESH_COOKIE, result.refreshToken, this.cookieOptions());
    return result.response;
  }

  private cookieToken(req: Request): string | undefined {
    const value = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  @Public()
  @Post('otp/request')
  @HttpCode(200)
  @RateLimit(
    { name: 'otp-ip', limit: 10, windowSeconds: 3600, by: 'ip' },
    { name: 'otp-mobile', limit: 5, windowSeconds: 900, by: byMobile },
  )
  @ApiZodBody(OtpRequestDto)
  requestOtp(@Body() dto: OtpRequestDto, @ReqContext() ctx: AuditContext): Promise<OtpChallengeResponse> {
    return this.auth.requestOtp(dto.mobile, ctx);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  @RateLimit({ name: 'otp-verify', limit: 30, windowSeconds: 900, by: 'ip' })
  @ApiZodBody(OtpVerifyDto)
  async verifyOtp(
    @Body() dto: OtpVerifyDto,
    @ReqContext() ctx: AuditContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthStepResponse> {
    return this.finish(res, await this.auth.verifyOtp(dto.challengeId, dto.code, ctx));
  }

  @Public()
  @Post('signup')
  @HttpCode(200)
  @RateLimit({ name: 'signup', limit: 10, windowSeconds: 3600, by: 'ip' })
  @ApiZodBody(SignupDto)
  async signup(
    @Body() dto: SignupDto,
    @ReqContext() ctx: AuditContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthStepResponse> {
    return this.finish(res, await this.auth.signup(dto, ctx));
  }

  @Public()
  @Post('admin/login')
  @HttpCode(200)
  @RateLimit({ name: 'login', limit: 10, windowSeconds: 60, by: 'ip' })
  @ApiZodBody(AdminLoginDto)
  async adminLogin(@Body() dto: AdminLoginDto, @ReqContext() ctx: AuditContext): Promise<AuthStepResponse> {
    return (await this.auth.adminLogin(dto.email, dto.password, ctx)).response;
  }

  @Public()
  @Post('admin/mfa/enroll')
  @HttpCode(200)
  @RateLimit({ name: 'mfa', limit: 20, windowSeconds: 300, by: 'ip' })
  @ApiZodBody(MfaTokenDto)
  enrollMfa(@Body() dto: MfaTokenDto): Promise<MfaEnrollmentResponse> {
    return this.auth.startMfaEnrollment(dto.mfaToken);
  }

  @Public()
  @Post('admin/mfa/enroll/confirm')
  @HttpCode(200)
  @RateLimit({ name: 'mfa', limit: 20, windowSeconds: 300, by: 'ip' })
  @ApiZodBody(MfaVerifyDto)
  async confirmMfa(
    @Body() dto: MfaVerifyDto,
    @ReqContext() ctx: AuditContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthStepResponse> {
    return this.finish(res, await this.auth.confirmMfaEnrollment(dto.mfaToken, dto.totp, ctx));
  }

  @Public()
  @Post('admin/mfa/verify')
  @HttpCode(200)
  @RateLimit({ name: 'mfa', limit: 20, windowSeconds: 300, by: 'ip' })
  @ApiZodBody(MfaVerifyDto)
  async verifyMfa(
    @Body() dto: MfaVerifyDto,
    @ReqContext() ctx: AuditContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthStepResponse> {
    return this.finish(res, await this.auth.verifyMfa(dto.mfaToken, dto.totp, ctx));
  }

  @Public()
  @Post('password/login')
  @HttpCode(200)
  @RateLimit({ name: 'login', limit: 10, windowSeconds: 60, by: 'ip' })
  @ApiZodBody(PasswordLoginDto)
  async passwordLogin(
    @Body() dto: PasswordLoginDto,
    @ReqContext() ctx: AuditContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthStepResponse> {
    return this.finish(res, await this.auth.passwordLogin(dto.email, dto.password, ctx));
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(202)
  @RateLimit({ name: 'pwd-forgot', limit: 5, windowSeconds: 900, by: 'ip' })
  @ApiZodBody(ForgotPasswordDto)
  async forgot(@Body() dto: ForgotPasswordDto, @ReqContext() ctx: AuditContext): Promise<{ accepted: true }> {
    await this.auth.forgotPassword(dto.email, ctx);
    return { accepted: true };
  }

  @Public()
  @Post('password/reset')
  @HttpCode(200)
  @RateLimit({ name: 'pwd-reset', limit: 10, windowSeconds: 900, by: 'ip' })
  @ApiZodBody(ResetPasswordDto)
  async reset(@Body() dto: ResetPasswordDto, @ReqContext() ctx: AuditContext): Promise<{ reset: true }> {
    await this.auth.resetPassword(dto.token, dto.newPassword, ctx);
    return { reset: true };
  }

  @ApiBearerAuth()
  @Put('password')
  @ApiZodBody(ChangePasswordDto)
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthStepResponse> {
    return this.finish(res, await this.auth.changePassword(user, dto.currentPassword, dto.newPassword, ctx));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @RateLimit({ name: 'refresh', limit: 60, windowSeconds: 60, by: 'ip' })
  async refresh(
    @Req() req: Request,
    @ReqContext() ctx: AuditContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    try {
      const result = await this.auth.refresh(this.cookieToken(req), ctx);
      res.cookie(REFRESH_COOKIE, result.refreshToken, this.cookieOptions());
      return { accessToken: result.accessToken, expiresIn: result.expiresIn };
    } catch (err) {
      res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
      throw err;
    }
  }

  /** Public so an expired access token does not prevent signing out. */
  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() req: Request,
    @ReqContext() ctx: AuditContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ loggedOut: true }> {
    await this.auth.logout(this.cookieToken(req), ctx);
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
    return { loggedOut: true };
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<SessionUser> {
    return this.auth.me(user);
  }
}

@ApiTags('Users (admin)')
@ApiBearerAuth()
@Controller('admin/users')
export class AdminSessionsController {
  constructor(private readonly auth: AuthService) {}

  @Post(':id/sessions/revoke')
  @HttpCode(200)
  @RequirePermissions('session.revoke')
  revoke(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<{ revokedSessions: number }> {
    return this.auth.forceLogout(id, actorFromUser(user), ctx);
  }
}
