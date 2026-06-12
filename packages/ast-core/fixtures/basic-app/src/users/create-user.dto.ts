import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { UserRole } from "./user-role.enum";

export class CreateUserDto {
  @IsString()
  @MaxLength(120)
  name: string;

  @IsEmail()
  email: string;

  @IsEnum(UserRole)
  @IsOptional()
  role?: UserRole;

  @IsBoolean()
  isActive: boolean;
}
