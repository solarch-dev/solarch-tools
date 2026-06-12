import { AddressDto } from "./address.dto";

export class UserResponseDto {
  id: string;
  name: string;
  email: string;
  addresses?: AddressDto[];
}
