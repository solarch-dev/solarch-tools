import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { UsersRepository } from "./users.repository";
import { AuthGuard } from "../auth/auth.guard";
import { MailModule } from "../mail/mail.module";

@Module({
  imports: [MailModule],
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService],
})
export class UsersModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthGuard).forRoutes(UsersController);
  }
}
