import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { UserRole } from "./user-role.enum";
import { Team } from "./team.entity";

@Entity("users")
export class User {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ length: 120 })
  name: string;

  @Column({ unique: true })
  email: string;

  @Column({ type: "enum", nullable: true })
  role?: UserRole;

  @Column({ type: "boolean" })
  isActive: boolean;

  @ManyToOne(() => Team)
  @JoinColumn({ name: "team_id" })
  team: Team;
}
