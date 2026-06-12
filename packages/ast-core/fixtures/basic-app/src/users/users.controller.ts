import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { UsersService } from "./users.service";
import { CreateUserDto } from "./create-user.dto";
import { UserResponseDto } from "./user-response.dto";
import { AuthGuard } from "../auth/auth.guard";

@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @UseGuards(AuthGuard)
  create(@Body() input: CreateUserDto): Promise<UserResponseDto> {
    return this.usersService.createUser(input);
  }

  @Get()
  list(@Query() limit?: number): Promise<UserResponseDto[]> {
    return this.usersService.listActive();
  }

  @Get(":id")
  byId(@Param("id") id: string): Promise<UserResponseDto> {
    return this.usersService.listActive().then((u) => u[0]);
  }
}
