import { Injectable } from "@nestjs/common";

@Injectable()
export class MailService {
  async sendWelcome(email: string): Promise<void> {
    // pretend to send
  }
}
