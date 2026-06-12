import { Injectable } from "@nestjs/common";
import { UsersRepository } from "./users.repository";
import { CreateUserDto } from "./create-user.dto";
import { UserResponseDto } from "./user-response.dto";
import { UserNotFoundException } from "./user-not-found.exception";
import { MailService } from "../mail/mail.service";

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly mailService: MailService,
  ) {}

  async createUser(input: CreateUserDto): Promise<UserResponseDto> {
    const existing = await this.usersRepository.findByEmail(input.email);
    if (existing) {
      throw new UserNotFoundException(input.email);
    }
    await this.mailService.sendWelcome(input.email);
    return { id: "new", name: input.name, email: input.email };
  }

  async listActive(): Promise<UserResponseDto[]> {
    const users = await this.usersRepository.findActive();
    return users.map((u) => ({ id: u.id, name: u.name, email: u.email }));
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }
}
