import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { UsersService } from "../users/users.service";

@Injectable()
export class CleanupWorker {
  constructor(private readonly usersService: UsersService) {}

  @Cron("0 3 * * *")
  async run(): Promise<void> {
    await this.usersService.listActive();
  }
}
