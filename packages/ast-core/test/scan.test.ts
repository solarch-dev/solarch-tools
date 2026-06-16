import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scanProject } from "../src/scan.js";
import { nameOfNode } from "../src/types.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "basic-app");

describe("scanProject (basic-app fixture)", () => {
  const graph = scanProject({ rootDir: FIXTURE });

  it("classifies every architecture node", () => {
    const byKey = Object.fromEntries(graph.nodes.map((n) => [n.key, n.kind]));
    expect(byKey).toMatchInlineSnapshot(`
      {
        "Controller:userscontroller": "Controller",
        "DTO:addressdto": "DTO",
        "DTO:createuserdto": "DTO",
        "DTO:userresponsedto": "DTO",
        "Enum:userrole": "Enum",
        "Exception:usernotfoundexception": "Exception",
        "Middleware:authguard": "Middleware",
        "Repository:usersrepository": "Repository",
        "Service:mailservice": "Service",
        "Service:usersservice": "Service",
        "Table:team": "Table",
        "Table:user": "Table",
        "Worker:cleanupworker": "Worker",
      }
    `);
  });

  it("derives edges from constructor injection, refs and module metadata", () => {
    expect(graph.edges.map((e) => e.key)).toMatchInlineSnapshot(`
      [
        "Controller:userscontroller -[CALLS]-> Service:usersservice",
        "Controller:userscontroller -[RETURNS]-> DTO:userresponsedto",
        "Controller:userscontroller -[USES]-> DTO:createuserdto",
        "DTO:createuserdto -[USES]-> Enum:userrole",
        "DTO:userresponsedto -[HAS]-> DTO:addressdto",
        "Middleware:authguard -[ROUTES_TO]-> Controller:userscontroller",
        "Repository:usersrepository -[QUERIES]-> Table:user",
        "Repository:usersrepository -[WRITES]-> Table:user",
        "Service:usersservice -[CALLS]-> Repository:usersrepository",
        "Service:usersservice -[CALLS]-> Service:mailservice",
        "Service:usersservice -[RETURNS]-> DTO:userresponsedto",
        "Service:usersservice -[THROWS]-> Exception:usernotfoundexception",
        "Service:usersservice -[USES]-> DTO:createuserdto",
        "Table:user -[USES]-> Enum:userrole",
        "Worker:cleanupworker -[CALLS]-> Service:usersservice",
      ]
    `);
  });

  it("maps Table properties to the backend schema shape", () => {
    const user = graph.nodes.find((n) => n.key === "Table:user")!;
    expect(user.properties).toMatchInlineSnapshot(`
      {
        "CheckConstraints": [],
        "Columns": [
          {
            "AutoIncrement": false,
            "DataType": "UUID",
            "IsNotNull": true,
            "IsPrimaryKey": true,
            "IsUnique": false,
            "Name": "id",
          },
          {
            "AutoIncrement": false,
            "DataType": "VARCHAR",
            "IsNotNull": true,
            "IsPrimaryKey": false,
            "IsUnique": false,
            "Length": 120,
            "Name": "name",
          },
          {
            "AutoIncrement": false,
            "DataType": "VARCHAR",
            "IsNotNull": true,
            "IsPrimaryKey": false,
            "IsUnique": true,
            "Name": "email",
          },
          {
            "AutoIncrement": false,
            "DataType": "ENUM",
            "EnumRef": "UserRole",
            "IsNotNull": false,
            "IsPrimaryKey": false,
            "IsUnique": false,
            "Name": "role",
          },
          {
            "AutoIncrement": false,
            "DataType": "BOOLEAN",
            "IsNotNull": true,
            "IsPrimaryKey": false,
            "IsUnique": false,
            "Name": "isActive",
          },
        ],
        "Description": "User entity",
        "ForeignKeys": [
          {
            "Columns": [
              "team_id",
            ],
            "OnDelete": "NO_ACTION",
            "OnUpdate": "NO_ACTION",
            "ReferencesColumns": [
              "id",
            ],
            "ReferencesTable": "teams",
          },
        ],
        "Indexes": [],
        "TableName": "users",
        "UniqueConstraints": [],
      }
    `);
  });

  it("maps Controller endpoints with DTO refs and auth flags", () => {
    const ctrl = graph.nodes.find((n) => n.key === "Controller:userscontroller")!;
    const endpoints = ctrl.properties.Endpoints as Record<string, unknown>[];
    expect(ctrl.properties.BaseRoute).toBe("/users");
    expect(endpoints).toHaveLength(3);
    expect(endpoints[0]).toMatchObject({
      HttpMethod: "POST",
      Route: "/",
      RequestDTORef: "CreateUserDto",
      ResponseDTORef: "UserResponseDto",
      RequiresAuth: true,
    });
    expect(endpoints[2]).toMatchObject({
      HttpMethod: "GET",
      Route: "/:id",
      PathParams: [{ Name: "id", Type: "string" }],
      RequiresAuth: false,
    });
  });

  it("extracts Service methods (public only, async detection)", () => {
    const svc = graph.nodes.find((n) => n.key === "Service:usersservice")!;
    const methods = svc.properties.Methods as Record<string, unknown>[];
    expect(methods.map((m) => m.MethodName)).toEqual(["createUser", "listActive"]);
    expect(methods[0]).toMatchObject({ IsAsync: true, ReturnDtoRef: "UserResponseDto" });
  });

  it("resolves repository EntityReference to the table name", () => {
    const repo = graph.nodes.find((n) => n.key === "Repository:usersrepository")!;
    expect(repo.properties.EntityReference).toBe("users");
  });

  it("every node exposes a canonical name through nameOfNode", () => {
    for (const n of graph.nodes) {
      expect(nameOfNode(n.kind, n.properties), `${n.key} has empty name field`).not.toBe("");
    }
  });

  it("emits no warnings on a clean fixture", () => {
    expect(graph.warnings).toEqual([]);
  });
});
