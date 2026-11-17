import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { AdminSessionsController, AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { AUTH_SCHEMAS } from './schemas';
import { SessionService } from './session.service';

/** Authentication (SRS §3.1): OTP, password + TOTP, refresh-token rotation, password reset. */
@Module({
  imports: [MongooseModule.forFeature(AUTH_SCHEMAS), UsersModule, NotificationsModule],
  controllers: [AuthController, AdminSessionsController],
  providers: [AuthService, OtpService, SessionService],
})
export class AuthModule {}
