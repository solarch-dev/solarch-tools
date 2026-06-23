import { describe, expect, it } from "vitest";
import { WILDCARD_CONTROLLER_KEY, WILDCARD_SERVICE_KEY, type AsIsGraph } from "@solarch/ast-core";
import { diffGraphs } from "../src/diff/engine.js";
import type { CloudGraph, RuleCatalog } from "../src/api.js";

/* ── sentetik graf kurucuları ────────────────────────────────────── */

function asIs(partial?: Partial<AsIsGraph>): AsIsGraph {
  return {
    scannedAt: "t",
    rootDir: "/repo",
    tsconfigPath: null,
    fileCount: 1,
    nodes: [
      {
        key: "Service:usersservice",
        kind: "Service",
        name: "UsersService",
        file: "src/users/users.service.ts",
        properties: { ServiceName: "UsersService", Methods: [{ MethodName: "create" }, { MethodName: "list" }] },
      },
      {
        key: "Repository:usersrepository",
        kind: "Repository",
        name: "UsersRepository",
        file: "src/users/users.repository.ts",
        properties: { RepositoryName: "UsersRepository" },
      },
    ],
    edges: [
      {
        key: "Service:usersservice -[CALLS]-> Repository:usersrepository",
        kind: "CALLS",
        sourceKey: "Service:usersservice",
        targetKey: "Repository:usersrepository",
        file: "src/users/users.service.ts",
        reason: "constructor injection",
      },
    ],
    warnings: [],
    ...partial,
  };
}

function toBe(partial?: Partial<CloudGraph>): CloudGraph {
  return {
    project: { id: "p1", name: "Demo" },
    nodes: [
      { id: "n1", type: "Service", projectId: "p1", version: 1, properties: { ServiceName: "UsersService", Methods: [{ MethodName: "create" }, { MethodName: "list" }] } },
      { id: "n2", type: "Repository", projectId: "p1", version: 1, properties: { RepositoryName: "UsersRepository" } },
    ],
    edges: [
      { id: "e1", kind: "CALLS", sourceNodeId: "n1", targetNodeId: "n2", properties: {} },
    ],
    counts: { nodes: 2, edges: 1 },
    graphRevision: 0,
    ...partial,
  };
}

const RULES: RuleCatalog = {
  whitelist: [
    { source: "Service", edge: "CALLS", target: ["Repository", "Service"], layer: "business" },
    { source: "Controller", edge: "CALLS", target: "Service", layer: "presentation" },
  ],
  blacklist: [
    {
      code: "ERR_001",
      source: "Controller",
      edge: "*",
      target: "Repository",
      message: "Controller cannot touch the Repository directly.",
      suggestion: "Go through a Service.",
    },
  ],
};

/* ── testler ─────────────────────────────────────────────────────── */

describe("diffGraphs", () => {
  it("tam eşleşmede bulgu üretmez", () => {
    const r = diffGraphs(asIs(), toBe(), RULES, {});
    expect(r.findings).toEqual([]);
    expect(r.matched).toBe(2);
    // cache dolduruldu — sonraki koşuda isim değişse de eşleşme korunur.
    expect(r.cache).toEqual({
      "Service:usersservice": "n1",
      "Repository:usersrepository": "n2",
    });
  });

  it("cloud'da olup kodda olmayan node → error", () => {
    const cloud = toBe();
    cloud.nodes.push({ id: "n3", type: "Controller", projectId: "p1", version: 1, properties: { ControllerName: "UsersController" } });
    const r = diffGraphs(asIs(), cloud, RULES, {});
    expect(r.counts.errors).toBe(1);
    expect(r.findings[0]).toMatchObject({ code: "DRIFT_NODE_MISSING_IN_CODE", severity: "error" });
  });

  it("kodda olup cloud'da olmayan node → warn", () => {
    const code = asIs();
    code.nodes.push({
      key: "Service:rogueservice",
      kind: "Service",
      name: "RogueService",
      file: "src/rogue.service.ts",
      properties: { ServiceName: "RogueService" },
    });
    const r = diffGraphs(code, toBe(), RULES, {});
    expect(r.counts.warns).toBe(1);
    expect(r.findings[0]).toMatchObject({ code: "DRIFT_NODE_NOT_IN_CLOUD", severity: "warn", file: "src/rogue.service.ts" });
  });

  it("cloud'daki edge kodda yoksa → error", () => {
    const r = diffGraphs(asIs({ edges: [] }), toBe(), RULES, {});
    expect(r.counts.errors).toBe(1);
    expect(r.findings[0]).toMatchObject({ code: "DRIFT_EDGE_MISSING_IN_CODE" });
  });

  it("koddaki onaysız edge → warn; blacklist ihlali → error", () => {
    const code = asIs();
    code.nodes.push({
      key: "Controller:userscontroller",
      kind: "Controller",
      name: "UsersController",
      file: "src/users/users.controller.ts",
      properties: { ControllerName: "UsersController" },
    });
    // Controller → Repository: ERR_001 blacklist (gizlice sızdırılan bağlantı).
    code.edges.push({
      key: "Controller:userscontroller -[CALLS]-> Repository:usersrepository",
      kind: "CALLS",
      sourceKey: "Controller:userscontroller",
      targetKey: "Repository:usersrepository",
      file: "src/users/users.controller.ts",
      reason: "constructor injection: repo: UsersRepository",
    });
    const cloud = toBe();
    cloud.nodes.push({ id: "n3", type: "Controller", projectId: "p1", version: 1, properties: { ControllerName: "UsersController" } });

    const r = diffGraphs(code, cloud, RULES, {});
    const illegal = r.findings.find((f) => f.code === "DRIFT_ILLEGAL_EDGE");
    expect(illegal).toBeDefined();
    expect(illegal!.severity).toBe("error");
    expect(illegal!.message).toContain("ERR_001");
    expect(illegal!.suggestion).toContain("Service");
  });

  it("whitelist dışı edge (default deny) → error", () => {
    const code = asIs();
    // Repository → Service: whitelist'te yok.
    code.edges.push({
      key: "Repository:usersrepository -[CALLS]-> Service:usersservice",
      kind: "CALLS",
      sourceKey: "Repository:usersrepository",
      targetKey: "Service:usersservice",
      file: "src/users/users.repository.ts",
      reason: "constructor injection",
    });
    const r = diffGraphs(code, toBe(), RULES, {});
    const illegal = r.findings.find((f) => f.code === "DRIFT_ILLEGAL_EDGE");
    expect(illegal).toBeDefined();
    expect(illegal!.message).toContain("default deny");
  });

  it("property farkı (method eksiği) → info", () => {
    const code = asIs();
    (code.nodes[0]!.properties as Record<string, unknown>).Methods = [{ MethodName: "create" }]; // "list" silinmiş
    const r = diffGraphs(code, toBe(), RULES, {});
    expect(r.counts.infos).toBe(1);
    expect(r.findings[0]).toMatchObject({ code: "DRIFT_PROPERTY", severity: "info" });
    expect(r.findings[0]!.message).toContain("list");
  });

  it("cache, cloud'da yeniden adlandırılan node'un eşleşmesini korur", () => {
    const cloud = toBe();
    // Cloud'da isim değişti: UsersService → AccountService (id aynı: n1).
    cloud.nodes[0]!.properties = { ServiceName: "AccountService", Methods: [{ MethodName: "create" }, { MethodName: "list" }] };
    // Cache önceki koşudan eşleşmeyi biliyor.
    const r = diffGraphs(asIs(), cloud, RULES, { "Service:usersservice": "n1" });
    expect(r.findings.filter((f) => f.code === "DRIFT_NODE_MISSING_IN_CODE")).toEqual([]);
    expect(r.matched).toBe(2);
  });

  it("Table'ı sınıf adı (Reservation) ≠ TableName (reservations) olsa da TableName ile eşler", () => {
    // @Entity("reservations") class Reservation → node.key sınıf adından ("Table:reservation"),
    // ama TableName "reservations". Cloud Table "Reservations". Cache yok → kanonik isimle
    // eşleşmeli (regresyon: node.key ile eşleşmeye çalışırsa false DRIFT_NODE_MISSING_IN_CODE).
    const code: AsIsGraph = {
      scannedAt: "t", rootDir: "/repo", tsconfigPath: null, fileCount: 1,
      nodes: [{
        key: "Table:reservation", kind: "Table", name: "Reservation",
        file: "src/reservation/reservation.entity.ts",
        properties: { TableName: "reservations", Description: "Reservations", Columns: [{ Name: "id" }] },
      }],
      edges: [], warnings: [],
    };
    const cloud: CloudGraph = {
      project: { id: "p1", name: "Demo" },
      nodes: [{ id: "n1", type: "Table", projectId: "p1", version: 1, properties: { TableName: "Reservations" } }],
      edges: [], counts: { nodes: 1, edges: 0 }, graphRevision: 0,
    };
    const r = diffGraphs(code, cloud, null, {}); // boş cache → isimle eşleşmeli
    expect(r.findings.filter((f) => f.code === "DRIFT_NODE_MISSING_IN_CODE")).toEqual([]);
    expect(r.matched).toBe(1);
  });

  it("endpoint path-param yazımı: bulut {id} ile kod :id aynı endpoint (false DRIFT_PROPERTY yok)", () => {
    const code = asIs();
    code.nodes.push({
      key: "Controller:orderscontroller",
      kind: "Controller",
      name: "OrdersController",
      file: "src/orders/orders.controller.ts",
      properties: { ControllerName: "OrdersController", Endpoints: [{ Route: "/:id" }, { Route: "/user/:userId" }] },
    });
    const cloud = toBe();
    cloud.nodes.push({
      id: "n3",
      type: "Controller",
      projectId: "p1",
      version: 1,
      properties: { ControllerName: "OrdersController", Endpoints: [{ Route: "/{id}" }, { Route: "/user/{userid}" }] },
    });
    const r = diffGraphs(code, cloud, null, {});
    expect(r.findings.filter((f) => f.code === "DRIFT_PROPERTY")).toEqual([]);
  });

  it("Controller USES DTO (bulut) ↔ RETURNS DTO (kod) drift değil — RETURNS, USES'i karşılar", () => {
    const code = asIs();
    code.nodes.push(
      {
        key: "Controller:orderscontroller",
        kind: "Controller",
        name: "OrdersController",
        file: "src/orders/orders.controller.ts",
        properties: { ControllerName: "OrdersController" },
      },
      {
        key: "DTO:orderresponse",
        kind: "DTO",
        name: "OrderResponse",
        file: "src/orders/dto/order-response.dto.ts",
        properties: { Name: "OrderResponse" },
      },
    );
    code.edges.push({
      key: "Controller:orderscontroller -[RETURNS]-> DTO:orderresponse",
      kind: "RETURNS",
      sourceKey: "Controller:orderscontroller",
      targetKey: "DTO:orderresponse",
      file: "src/orders/orders.controller.ts",
      reason: "return type OrderResponse",
    });
    const cloud = toBe();
    cloud.nodes.push(
      { id: "n3", type: "Controller", projectId: "p1", version: 1, properties: { ControllerName: "OrdersController" } },
      { id: "n4", type: "DTO", projectId: "p1", version: 1, properties: { Name: "OrderResponse" } },
    );
    cloud.edges.push({ id: "e2", kind: "USES", sourceNodeId: "n3", targetNodeId: "n4", properties: {} });
    const r = diffGraphs(code, cloud, null, {});
    expect(r.findings.filter((f) => f.code === "DRIFT_EDGE_MISSING_IN_CODE")).toEqual([]);
    expect(r.findings.filter((f) => f.code === "DRIFT_EDGE_NOT_IN_CLOUD")).toEqual([]);
  });

  it("global middleware joker'i (forRoutes('*')) bulutta çizilen ROUTES_TO'ları karşılar, gürültü yapmaz", () => {
    const code: AsIsGraph = {
      scannedAt: "t",
      rootDir: "/repo",
      tsconfigPath: null,
      fileCount: 1,
      nodes: [
        {
          key: "Middleware:ratelimitmiddleware",
          kind: "Middleware",
          name: "RateLimitMiddleware",
          file: "src/common/common.module.ts",
          properties: { MiddlewareName: "RateLimitMiddleware" },
        },
        { key: "Controller:authcontroller", kind: "Controller", name: "AuthController", file: "src/auth/auth.controller.ts", properties: { ControllerName: "AuthController" } },
        { key: "Controller:menucontroller", kind: "Controller", name: "MenuController", file: "src/menu/menu.controller.ts", properties: { ControllerName: "MenuController" } },
      ],
      // forRoutes("*") → tek joker edge (controller başına değil).
      edges: [
        {
          key: `Middleware:ratelimitmiddleware -[ROUTES_TO]-> ${WILDCARD_CONTROLLER_KEY}`,
          kind: "ROUTES_TO",
          sourceKey: "Middleware:ratelimitmiddleware",
          targetKey: WILDCARD_CONTROLLER_KEY,
          file: "src/common/common.module.ts",
          reason: "CommonModule.configure: RateLimitMiddleware → * (all routes)",
        },
      ],
      warnings: [],
    };
    const cloud: CloudGraph = {
      project: { id: "p1", name: "Demo" },
      nodes: [
        { id: "n1", type: "Middleware", projectId: "p1", version: 1, properties: { MiddlewareName: "RateLimitMiddleware" } },
        { id: "n2", type: "Controller", projectId: "p1", version: 1, properties: { ControllerName: "AuthController" } },
        { id: "n3", type: "Controller", projectId: "p1", version: 1, properties: { ControllerName: "MenuController" } },
      ],
      // Bulut sadece AuthController'a çizmiş — joker ikisini de karşılamalı.
      edges: [{ id: "e1", kind: "ROUTES_TO", sourceNodeId: "n1", targetNodeId: "n2", properties: {} }],
      counts: { nodes: 3, edges: 1 },
      graphRevision: 0,
    };
    const r = diffGraphs(code, cloud, null, {});
    expect(r.findings.filter((f) => f.code === "DRIFT_EDGE_MISSING_IN_CODE")).toEqual([]);
    expect(r.findings.filter((f) => f.code === "DRIFT_EDGE_NOT_IN_CLOUD")).toEqual([]);
  });

  it("iskelet stub'ın surgical `throws:` kontratı cloud THROWS taahhüdünü karşılar", () => {
    const code = asIs();
    // Stub gövdesi hâlâ NOT_IMPLEMENTED Error atar (iskelet) ama surgical kontrat
    // "NotFoundException fırlatacak" diye beyan eder → mimari taahhüt karşılanır.
    code.nodes[0]!.surgical = [
      { member: "getById", nodeId: "n1", status: "skeleton", throws: ["NotFoundException"], line: 10 },
    ];
    code.nodes.push({
      key: "Exception:notfoundexception",
      kind: "Exception",
      name: "NotFoundException",
      file: "src/exceptions/not-found.exception.ts",
      properties: { ExceptionName: "NotFoundException" },
    });
    const cloud = toBe();
    cloud.nodes.push({ id: "n9", type: "Exception", projectId: "p1", version: 1, properties: { ExceptionName: "NotFoundException" } });
    cloud.edges.push({ id: "e9", kind: "THROWS", sourceNodeId: "n1", targetNodeId: "n9", properties: {} });
    const r = diffGraphs(code, cloud, null, {});
    expect(r.findings.filter((f) => f.code === "DRIFT_EDGE_MISSING_IN_CODE")).toEqual([]);
  });

  it("cloud DTO alanındaki EnumRef, koddaki DTO USES Enum edge'ini karşılar (NOT_IN_CLOUD yok)", () => {
    const code = asIs();
    code.nodes.push(
      { key: "DTO:orderresponse", kind: "DTO", name: "OrderResponse", file: "src/dto/order-response.dto.ts", properties: { Name: "OrderResponse" } },
      { key: "Enum:orderstatus", kind: "Enum", name: "OrderStatus", file: "src/enums/order-status.enum.ts", properties: { Name: "OrderStatus" } },
    );
    code.edges.push({
      key: "DTO:orderresponse -[USES]-> Enum:orderstatus",
      kind: "USES",
      sourceKey: "DTO:orderresponse",
      targetKey: "Enum:orderstatus",
      file: "src/dto/order-response.dto.ts",
      reason: "enum reference OrderStatus",
    });
    const cloud = toBe();
    cloud.nodes.push(
      // Cloud'da DTO->Enum EDGE'i YOK — yalnız alan-düzeyi EnumRef taşıyor.
      { id: "n7", type: "DTO", projectId: "p1", version: 1, properties: { Name: "OrderResponse", Fields: [{ Name: "status", EnumRef: "OrderStatus" }] } },
      { id: "n8", type: "Enum", projectId: "p1", version: 1, properties: { Name: "OrderStatus" } },
    );
    const r = diffGraphs(code, cloud, null, {});
    expect(r.findings.filter((f) => f.code === "DRIFT_EDGE_NOT_IN_CLOUD")).toEqual([]);
  });

  it("Controller nested DTO'yu dıştaki DTO üzerinden kullanınca USES karşılanır, HAS gürültü yapmaz", () => {
    const code = asIs();
    code.nodes.push(
      { key: "Controller:orderscontroller", kind: "Controller", name: "OrdersController", file: "src/orders/orders.controller.ts", properties: { ControllerName: "OrdersController" } },
      { key: "DTO:ordercreaterequest", kind: "DTO", name: "OrderCreateRequest", file: "src/orders/dto/order-create.request.ts", properties: { Name: "OrderCreateRequest" } },
      { key: "DTO:orderitemrequest", kind: "DTO", name: "OrderItemRequest", file: "src/orders/dto/order-item.request.ts", properties: { Name: "OrderItemRequest" } },
    );
    code.edges.push(
      { key: "Controller:orderscontroller -[USES]-> DTO:ordercreaterequest", kind: "USES", sourceKey: "Controller:orderscontroller", targetKey: "DTO:ordercreaterequest", file: "src/orders/orders.controller.ts", reason: "parameter type OrderCreateRequest" },
      { key: "DTO:ordercreaterequest -[HAS]-> DTO:orderitemrequest", kind: "HAS", sourceKey: "DTO:ordercreaterequest", targetKey: "DTO:orderitemrequest", file: "src/orders/dto/order-create.request.ts", reason: "nested field type OrderItemRequest" },
    );
    const cloud = toBe();
    cloud.nodes.push(
      { id: "n3", type: "Controller", projectId: "p1", version: 1, properties: { ControllerName: "OrdersController" } },
      { id: "n4", type: "DTO", projectId: "p1", version: 1, properties: { Name: "OrderCreateRequest", Fields: [{ Name: "items", NestedDTORef: "OrderItemRequest" }] } },
      { id: "n5", type: "DTO", projectId: "p1", version: 1, properties: { Name: "OrderItemRequest" } },
    );
    cloud.edges.push(
      { id: "e3", kind: "USES", sourceNodeId: "n3", targetNodeId: "n4", properties: {} }, // dıştaki: doğrudan eşleşir
      { id: "e4", kind: "USES", sourceNodeId: "n3", targetNodeId: "n5", properties: {} }, // flatten nested: transitif karşılanır
    );
    const r = diffGraphs(code, cloud, null, {});
    expect(r.findings.filter((f) => f.code === "DRIFT_EDGE_MISSING_IN_CODE")).toEqual([]);
    expect(r.findings.filter((f) => f.code === "DRIFT_EDGE_NOT_IN_CLOUD")).toEqual([]);
  });

  it("merkezi process.env okuması: cloud Service READS_CONFIG joker üzerinden karşılanır; fazlalık env var gürültü yapmaz", () => {
    const code = asIs();
    code.nodes.push(
      { key: "EnvironmentVariable:jwtsecret", kind: "EnvironmentVariable", name: "JWT_SECRET", file: "src/config/configuration.ts", properties: { Key: "JWT_SECRET" } },
      { key: "EnvironmentVariable:nodeenv", kind: "EnvironmentVariable", name: "NODE_ENV", file: "src/config/configuration.ts", properties: { Key: "NODE_ENV" } }, // cloud'da YOK
    );
    code.edges.push({
      key: `${WILDCARD_SERVICE_KEY} -[READS_CONFIG]-> EnvironmentVariable:jwtsecret`,
      kind: "READS_CONFIG",
      sourceKey: WILDCARD_SERVICE_KEY,
      targetKey: "EnvironmentVariable:jwtsecret",
      file: "src/config/configuration.ts",
      reason: "process.env.JWT_SECRET",
    });
    const cloud = toBe();
    cloud.nodes.push({ id: "n6", type: "EnvironmentVariable", projectId: "p1", version: 1, properties: { Key: "JWT_SECRET" } });
    cloud.edges.push({ id: "e6", kind: "READS_CONFIG", sourceNodeId: "n1", targetNodeId: "n6", properties: {} }); // UsersService READS_CONFIG JWT_SECRET
    const r = diffGraphs(code, cloud, null, {});
    expect(r.findings.filter((f) => f.code === "DRIFT_NODE_MISSING_IN_CODE")).toEqual([]); // JWT_SECRET eşleşti
    expect(r.findings.filter((f) => f.code === "DRIFT_NODE_NOT_IN_CLOUD")).toEqual([]); // NODE_ENV bastırıldı
    expect(r.findings.filter((f) => f.code === "DRIFT_EDGE_MISSING_IN_CODE")).toEqual([]); // READS_CONFIG joker karşıladı
  });

  it("rules null ise legalite kontrolü atlanır (offline)", () => {
    const code = asIs();
    code.edges.push({
      key: "Repository:usersrepository -[CALLS]-> Service:usersservice",
      kind: "CALLS",
      sourceKey: "Repository:usersrepository",
      targetKey: "Service:usersservice",
      file: "src/users/users.repository.ts",
      reason: "constructor injection",
    });
    const r = diffGraphs(code, toBe(), null, {});
    expect(r.findings.filter((f) => f.code === "DRIFT_ILLEGAL_EDGE")).toEqual([]);
    // ama "cloud'da yok" uyarısı yine düşer.
    expect(r.findings.filter((f) => f.code === "DRIFT_EDGE_NOT_IN_CLOUD")).toHaveLength(1);
  });
});

/* ── push --prune adayları (removable) ───────────────────────────── */

describe("diffGraphs — removable (push --prune)", () => {
  it("koddan silinen (önceden eşleşmiş) node cloud'da duruyorsa removable.nodes'a girer", () => {
    // Kod yalnız UsersService içeriyor; Repository silinmiş. Cache önceki koşudan
    // ikisini de biliyordu → n2 koddan silindiği KESİN (silme adayı).
    const code = asIs({ nodes: [asIs().nodes[0]!], edges: [] });
    const r = diffGraphs(code, toBe(), RULES, {
      "Service:usersservice": "n1",
      "Repository:usersrepository": "n2",
    });
    expect(r.removable.nodes.map((n) => n.id)).toEqual(["n2"]);
    expect(r.removable.edges).toEqual([]);
  });

  it("geçmişi olmayan (ilk koşu) eşleşmeyen cloud node SİLİNMEZ — yalnız drift", () => {
    const code = asIs({ nodes: [asIs().nodes[0]!], edges: [] });
    const r = diffGraphs(code, toBe(), RULES, {}); // boş cache → geçmiş yok
    expect(r.findings.some((f) => f.code === "DRIFT_NODE_MISSING_IN_CODE")).toBe(true);
    expect(r.removable.nodes).toEqual([]); // "henüz yapılmamış" olabilir → silme adayı değil
  });

  it("cloud'da yeniden adlandırılan node silme adayı SAYILMAZ (rename ≠ silme)", () => {
    const cloud = toBe();
    // Cloud'da isim değişti: UsersService → AccountService (id aynı: n1).
    cloud.nodes[0]!.properties = { ServiceName: "AccountService", Methods: [{ MethodName: "create" }, { MethodName: "list" }] };
    // Kod hâlâ UsersService; cache eski anahtarı n1'e bağlar → n1 yeniden eşleşir.
    const r = diffGraphs(asIs(), cloud, RULES, {
      "Service:usersservice": "n1",
      "Repository:usersrepository": "n2",
    });
    expect(r.removable.nodes).toEqual([]);
  });

  it("iki ucu eşleşen ama kodda olmayan cloud edge removable.edges'e girer (kaldırılmış bağımlılık)", () => {
    // Kod CALLS edge'ini kaybetmiş ama iki node da yaşıyor.
    const r = diffGraphs(asIs({ edges: [] }), toBe(), RULES, {});
    expect(r.removable.edges.map((e) => e.id)).toEqual(["e1"]);
    expect(r.removable.nodes).toEqual([]);
  });
});
