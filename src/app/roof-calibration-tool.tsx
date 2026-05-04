"use client";

import {
  area as turfArea,
  bbox as turfBbox,
  booleanPointInPolygon,
  buffer as turfBuffer,
  center as turfCenter,
  distance as turfDistance,
  point as turfPoint,
} from "@turf/turf";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from "geojson";
import mapboxgl from "mapbox-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type RoofFeature = Feature<Polygon | MultiPolygon>;
type ParcelFeature = Feature<MultiPolygon, ParcelProperties>;

type PitchValue = "3/12" | "4/12" | "6/12" | "8/12" | "10/12" | "12/12";
type Confidence = "High" | "Medium" | "Low" | "Unusable";
type GaragePolicy = "auto" | "include" | "exclude";
type AttachedGaragePolicy = "include" | "exclude";
type DwellingType = "Single detached" | "Duplex";
type EstimateStatus = "Loaded" | "Estimating" | "Estimated" | "No footprint" | "Error";
type AgeBand = "Pre-1950" | "1950-1969" | "1970-1989" | "1990-2009" | "2010+" | "Unknown";
type Language = "en" | "zh";
type StructureRole =
  | "Main roof"
  | "Attached roof candidate"
  | "Detached garage candidate"
  | "Small outbuilding"
  | "Nearby structure";

type CalgaryAssessmentRow = {
  address?: string;
  comm_name?: string;
  year_of_construction?: string;
  land_use_designation?: string;
  property_type?: string;
  sub_property_use?: string;
  assessment_class?: string;
  assessment_class_description?: string;
  multipolygon?: unknown;
  unique_key?: string;
  cpid?: string;
  roll_number?: string;
};

type CommunityAssumptions = {
  pitch: PitchValue;
  overhangInches: number;
  calibrationPercent: number;
  detachedGaragePolicy: GaragePolicy;
  attachedGaragePolicy: AttachedGaragePolicy;
  wasteFactor: number;
  includeDuplexes: boolean;
};

type EligibleAddress = {
  id: string;
  address: string;
  community: string;
  dwellingType: DwellingType;
  classificationSource: string;
  constructionYear: number | null;
  ageBand: AgeBand;
  landUse: string;
  propertyType: string;
  assessmentClass: string;
  assessmentClassDescription: string;
  subPropertyUse: string;
  uniqueKey: string;
  cpid: string;
  rollNumber: string;
  latitude: number | null;
  longitude: number | null;
  parcel: ParcelFeature | null;
  sourceRow: CalgaryAssessmentRow;
};

type ParcelProperties = {
  id: string;
  address: string;
  community: string;
  dwellingType: DwellingType;
  ageBand: AgeBand;
  constructionYear: number | null;
  subPropertyUse: string;
};

type Facet = {
  id: string;
  feature: RoofFeature;
  pitch: PitchValue;
  included: boolean;
  source: "address" | "nearby";
  role: StructureRole;
  includeReason: string;
};

type AutoEstimateResult =
  | {
      ok: true;
      facets: Facet[];
      source: string;
    }
  | { ok: false; reason: string };

type HouseOverride = {
  pitch?: PitchValue;
  overhangInches?: number;
  calibrationPercent?: number;
  detachedGaragePolicy?: GaragePolicy;
  attachedGaragePolicy?: AttachedGaragePolicy;
  wasteFactor?: number;
  confidence?: Confidence;
  notes?: string;
  facetOverrides?: Record<string, { included?: boolean; pitch?: PitchValue }>;
};

type BatchResult = {
  id: string;
  address: EligibleAddress;
  baseFacets: Facet[];
  facets: Facet[];
  sourceMessage: string;
  buildingFootprintSqft: number;
  overhangFootprintSqft: number;
  roofSqft: number;
  roofingSquares: number;
  wasteAdjustedSqft: number;
  pitch: PitchValue;
  overhangInches: number;
  calibrationPercent: number;
  wasteFactor: number;
  detachedGaragePolicy: GaragePolicy;
  attachedGaragePolicy: AttachedGaragePolicy;
  confidence: Confidence;
  expectedErrorPercent: number;
  flags: string[];
  assumptions: string[];
  includedStructures: number;
  excludedStructures: number;
  status: EstimateStatus;
};

type AddressTableColumnKey =
  | "dwellingType"
  | "year"
  | "ageBand"
  | "landUse"
  | "roofSqft"
  | "squares"
  | "confidence"
  | "expectedError"
  | "flags"
  | "status"
  | "view";

type LocalizedText = Record<Language, string>;

const SOCRATA_ENDPOINT = "https://data.calgary.ca/resource/4bsw-nn7w.json";
const SQM_TO_SQFT = 10.7639;
const MAX_ELIGIBLE_ADDRESSES = 100;
const DEFAULT_ASSUMPTIONS: CommunityAssumptions = {
  pitch: "6/12",
  overhangInches: 12,
  calibrationPercent: 5,
  detachedGaragePolicy: "exclude",
  attachedGaragePolicy: "include",
  wasteFactor: 10,
  includeDuplexes: true,
};
const OVERRIDES_STORAGE_KEY = "calgary-community-roof-overrides-v1";
const BUILDING_SOURCE_ID = "auto-building-source";
const BUILDING_FOOTPRINT_LAYER_ID = "auto-building-footprints";
const PARCEL_SOURCE_ID = "eligible-parcels-source";
const PARCEL_FILL_LAYER_ID = "eligible-parcels-fill";
const PARCEL_LINE_LAYER_ID = "eligible-parcels-line";
const SELECTED_PARCEL_SOURCE_ID = "selected-parcel-source";
const SELECTED_PARCEL_FILL_LAYER_ID = "selected-parcel-fill";
const SELECTED_PARCEL_LINE_LAYER_ID = "selected-parcel-line";
const SELECTED_ROOF_SOURCE_ID = "selected-roof-source";
const SELECTED_ROOF_FILL_LAYER_ID = "selected-roof-fill";
const SELECTED_ROOF_LINE_LAYER_ID = "selected-roof-line";

const EMPTY_FEATURE_COLLECTION: FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

const PITCH_OPTIONS: Array<{ label: PitchValue; multiplier: number }> = [
  { label: "3/12", multiplier: 1.031 },
  { label: "4/12", multiplier: 1.054 },
  { label: "6/12", multiplier: 1.118 },
  { label: "8/12", multiplier: 1.202 },
  { label: "10/12", multiplier: 1.302 },
  { label: "12/12", multiplier: 1.414 },
];
const ADDRESS_TABLE_COLUMNS: Array<{ key: AddressTableColumnKey; label: LocalizedText }> = [
  { key: "dwellingType", label: { en: "Dwelling", zh: "住宅类型" } },
  { key: "year", label: { en: "Year", zh: "年份" } },
  { key: "ageBand", label: { en: "Age", zh: "屋龄" } },
  { key: "landUse", label: { en: "Land use", zh: "土地用途" } },
  { key: "roofSqft", label: { en: "Roof sqft", zh: "屋顶面积" } },
  { key: "squares", label: { en: "Squares", zh: "屋面方" } },
  { key: "confidence", label: { en: "Confidence", zh: "可信度" } },
  { key: "expectedError", label: { en: "Error", zh: "误差" } },
  { key: "flags", label: { en: "Flags", zh: "提示" } },
  { key: "status", label: { en: "Status", zh: "状态" } },
  { key: "view", label: { en: "View", zh: "查看" } },
];

const UI_COPY = {
  en: {
    languageLabel: "Language",
    languageButton: "中文",
    title: "Roof Sqft Calibration Tool",
    subtitle:
      `Draw a Calgary block or cluster of houses, load up to ${MAX_ELIGIBLE_ADDRESSES} eligible residential parcels, then estimate each roof from Mapbox building footprints and Turf area calculations.`,
    metrics: {
      eligibleRows: "Eligible rows",
      estimated: "Estimated",
      noFootprint: "No footprint",
      batchSquares: "Batch squares",
    },
    drawPanel: "1. Draw houses to load",
    drawArea: "Draw area",
    drawInstruction: `Draw a polygon around the houses to load. Max ${MAX_ELIGIBLE_ADDRESSES} eligible rows.`,
    drawActive: "Click points on the map, then click the first point to close the area.",
    clear: "Clear",
    maxLoad: "Max load",
    drawnArea: "Drawn area",
    loadedRows: "Loaded rows",
    selectedSource: "Selected source",
    none: "None",
    houses: "houses",
    calgaryOpenData: "Calgary open data",
    parametersPanel: "2. Community parameters",
    defaultPitch: "Default pitch",
    overhang: "Overhang inches",
    calibration: "Calibration percent",
    wasteFactor: "Waste factor",
    detachedGarage: "Detached garage",
    attachedGarage: "Attached garage",
    includeDuplexes: "Include duplexes",
    includeR120: "Yes, include R120",
    r110Only: "No, R110 only",
    include: "Include",
    exclude: "Exclude",
    auto: "Auto",
    exclusionRule:
      "Exclusion rule: townhouse, rowhouse, condo, apartment, commercial, industrial, multi-unit, and non-residential rows are excluded because only RE + R110/R120 rows are loaded.",
    loadPanel: "3. Load and run",
    loadAndRun: "Load houses + run estimate",
    loadingSelected: "Loading houses",
    runningBatch: "Running estimate",
    exportCsv: "Export CSV",
    mapView: "Map view",
    mapboxRequired: "Mapbox token required.",
    duplexLegend: "Blue outlines mark duplex rows.",
    addressTable: "Address table",
    columns: "Columns",
    address: "Address",
    viewButton: "View",
    emptyTable:
      `Draw an area on the map and load up to ${MAX_ELIGIBLE_ADDRESSES} eligible Calgary houses. No pasted address list is needed.`,
    selectedAddress: "Selected address",
    selectedEmpty:
      "Draw an area and select an address row to inspect source data, assumptions, structures, and overrides.",
    roofSqft: "Roof sqft",
    roofingSquares: "Roofing squares",
    confidence: "Confidence",
    structures: "Structures",
    source: "Source",
    landUse: "Land use",
    assessment: "assessment",
    uniqueKey: "unique key",
    unknown: "unknown",
    notSupplied: "not supplied",
    pitchOverride: "Pitch override",
    notes: "Notes",
    notesPlaceholder: "Saved automatically to this browser",
    roofStructures: "Included/excluded roof structures",
    noFootprintAttached: "No Mapbox building footprint has been attached to this row yet.",
    structure: "Structure",
    included: "Included",
    excluded: "Excluded",
    flags: "Flags",
    assumptions: "Assumptions",
    sqft: "sqft",
    inOut: "in / {out} out",
  },
  zh: {
    languageLabel: "语言",
    languageButton: "English",
    title: "屋顶面积校准工具",
    subtitle:
      `在卡尔加里地图上圈选一个街区，载入最多 ${MAX_ELIGIBLE_ADDRESSES} 个符合条件的住宅地块，并用 Mapbox 建筑轮廓和 Turf 面积计算估算每个屋顶。`,
    metrics: {
      eligibleRows: "符合条件",
      estimated: "已估算",
      noFootprint: "无轮廓",
      batchSquares: "屋面方数",
    },
    drawPanel: "1. 圈选房屋",
    drawArea: "圈选区域",
    drawInstruction: `在地图上圈选要载入的住宅区域。最多 ${MAX_ELIGIBLE_ADDRESSES} 条记录。`,
    drawActive: "在地图上点击各个点，然后点击第一个点来闭合区域。",
    clear: "清除",
    maxLoad: "最多载入",
    drawnArea: "已圈区域",
    loadedRows: "已载入",
    selectedSource: "数据来源",
    none: "无",
    houses: "套住宅",
    calgaryOpenData: "卡尔加里开放数据",
    parametersPanel: "2. 社区参数",
    defaultPitch: "默认坡度",
    overhang: "屋檐外挑（英寸）",
    calibration: "校准比例",
    wasteFactor: "损耗比例",
    detachedGarage: "独立车库",
    attachedGarage: "连体车库",
    includeDuplexes: "包含双拼",
    includeR120: "是，包含 R120",
    r110Only: "否，仅 R110",
    include: "包含",
    exclude: "排除",
    auto: "自动",
    exclusionRule:
      "排除规则：联排、公寓、商业、工业、多户和非住宅记录会被排除；系统只载入 RE + R110/R120 住宅记录。",
    loadPanel: "3. 载入并估算",
    loadAndRun: "载入住宅并估算",
    loadingSelected: "正在载入住宅",
    runningBatch: "正在估算",
    exportCsv: "导出 CSV",
    mapView: "地图视图",
    mapboxRequired: "需要 Mapbox token。",
    duplexLegend: "蓝色边线表示双拼记录。",
    addressTable: "地址表",
    columns: "列",
    address: "地址",
    viewButton: "查看",
    emptyTable: `请先在地图上圈选区域并载入最多 ${MAX_ELIGIBLE_ADDRESSES} 个卡尔加里住宅地址。`,
    selectedAddress: "选中地址",
    selectedEmpty: "圈选区域并选择一个地址后，可查看来源数据、假设、结构和手动覆盖。",
    roofSqft: "屋顶面积",
    roofingSquares: "屋面方",
    confidence: "可信度",
    structures: "结构",
    source: "来源",
    landUse: "土地用途",
    assessment: "评估类别",
    uniqueKey: "唯一编号",
    unknown: "未知",
    notSupplied: "未提供",
    pitchOverride: "坡度覆盖",
    notes: "备注",
    notesPlaceholder: "自动保存到此浏览器",
    roofStructures: "包含/排除的屋顶结构",
    noFootprintAttached: "此记录尚未匹配到 Mapbox 建筑轮廓。",
    structure: "结构",
    included: "已包含",
    excluded: "已排除",
    flags: "提示",
    assumptions: "假设",
    sqft: "平方英尺",
    inOut: "包含 / 排除 {out}",
  },
} satisfies Record<Language, Record<string, unknown>>;

function pitchMultiplierFor(pitch: PitchValue) {
  return PITCH_OPTIONS.find((option) => option.label === pitch)?.multiplier ?? 1.118;
}

function formatNumber(value: number, digits = 0) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function localizeDwellingType(value: DwellingType, language: Language) {
  if (language === "en") {
    return value;
  }

  return value === "Duplex" ? "双拼" : "独立屋";
}

function localizeConfidence(value: Confidence, language: Language) {
  if (language === "en") {
    return value;
  }

  const labels = {
    High: "高",
    Medium: "中",
    Low: "低",
    Unusable: "不可用",
  } satisfies Record<Confidence, string>;

  return labels[value];
}

function localizeStatus(value: EstimateStatus, language: Language) {
  if (language === "en") {
    return value;
  }

  const labels = {
    Loaded: "已载入",
    Estimating: "估算中",
    Estimated: "已估算",
    "No footprint": "无轮廓",
    Error: "错误",
  } satisfies Record<EstimateStatus, string>;

  return labels[value];
}

function csvEscape(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }

  const raw = String(value);
  return /[",\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

function ageBandFor(year: number | null): AgeBand {
  if (!year) {
    return "Unknown";
  }

  if (year < 1950) {
    return "Pre-1950";
  }

  if (year < 1970) {
    return "1950-1969";
  }

  if (year < 1990) {
    return "1970-1989";
  }

  if (year < 2010) {
    return "1990-2009";
  }

  return "2010+";
}

function dwellingTypeForCode(code: string | undefined): DwellingType | null {
  if (code === "R110") {
    return "Single detached";
  }

  if (code === "R120") {
    return "Duplex";
  }

  return null;
}

function classificationLabel(code: string | undefined) {
  if (code === "R110") {
    return "Inferred from Calgary sub_property_use R110";
  }

  if (code === "R120") {
    return "Inferred from Calgary sub_property_use R120";
  }

  return "Excluded until this Calgary sub_property_use code is mapped with confidence";
}

function parseYear(value: string | undefined) {
  if (!value) {
    return null;
  }

  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function escapeSoqlLiteral(value: string) {
  return value.replaceAll("'", "''");
}

function normalizePosition(raw: unknown): [number, number] | null {
  if (Array.isArray(raw) && raw.length >= 2) {
    const lng = Number(raw[0]);
    const lat = Number(raw[1]);

    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
  }

  if (typeof raw === "string") {
    const [lngRaw, latRaw] = raw.trim().split(/\s+/);
    const lng = Number(lngRaw);
    const lat = Number(latRaw);

    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
  }

  return null;
}

function normalizeMultiPolygon(raw: unknown): MultiPolygon | null {
  if (!raw || typeof raw !== "object" || !("type" in raw) || !("coordinates" in raw)) {
    return null;
  }

  const candidate = raw as { type?: unknown; coordinates?: unknown };

  if (candidate.type !== "MultiPolygon" || !Array.isArray(candidate.coordinates)) {
    return null;
  }

  const coordinates = candidate.coordinates
    .map((polygon) =>
      Array.isArray(polygon)
        ? polygon
            .map((ring) =>
              Array.isArray(ring)
                ? ring
                    .map((position) => normalizePosition(position))
                    .filter((position): position is [number, number] => position !== null)
                : [],
            )
            .filter((ring) => ring.length >= 4)
        : [],
    )
    .filter((polygon) => polygon.length > 0);

  return coordinates.length > 0 ? { type: "MultiPolygon", coordinates } : null;
}

function polygonToWkt(geometry: Polygon) {
  const rings = geometry.coordinates
    .filter((ring) => ring.length >= 4)
    .map(
      (ring) =>
        `(${ring
          .map((position) => `${Number(position[0]).toFixed(7)} ${Number(position[1]).toFixed(7)}`)
          .join(",")})`,
    );

  return `POLYGON(${rings.join(",")})`;
}

function buildSocrataUrl(params: Record<string, string | number>) {
  const url = new URL(SOCRATA_ENDPOINT);

  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, String(value));
  });

  return url.toString();
}

function isRoofGeometry(
  geometry: Geometry | null | undefined,
): geometry is Polygon | MultiPolygon {
  return geometry?.type === "Polygon" || geometry?.type === "MultiPolygon";
}

function applyOverhang(feature: RoofFeature, overhangInches: number): RoofFeature {
  const overhangMeters = Math.max(0, overhangInches) * 0.0254;

  if (overhangMeters === 0) {
    return feature;
  }

  const buffered = turfBuffer(feature, overhangMeters, { units: "meters", steps: 8 });

  if (!buffered || !isRoofGeometry(buffered.geometry)) {
    return feature;
  }

  return {
    type: "Feature",
    id: feature.id,
    properties: feature.properties ?? {},
    geometry: buffered.geometry,
  };
}

function classifyStructure({
  areaSqft,
  containsAddressPoint,
  centerInParcel,
  isMainCandidate,
}: {
  areaSqft: number;
  containsAddressPoint: boolean;
  centerInParcel: boolean;
  isMainCandidate: boolean;
}): { role: StructureRole; included: boolean; includeReason: string } {
  if (isMainCandidate) {
    return {
      role: "Main roof",
      included: true,
      includeReason: containsAddressPoint
        ? "Selected footprint contains the Calgary parcel centroid."
        : centerInParcel
          ? "Largest parcel-contained footprint selected as the main roof."
          : "Best available footprint selected as the main roof.",
    };
  }

  if (areaSqft < 220) {
    return {
      role: "Small outbuilding",
      included: false,
      includeReason: "Small nearby footprint excluded from the automatic total.",
    };
  }

  if (areaSqft >= 280 && areaSqft <= 1100) {
    return {
      role: "Detached garage candidate",
      included: false,
      includeReason: "Garage-scale secondary footprint excluded from the automatic total.",
    };
  }

  return {
    role: "Nearby structure",
    included: false,
    includeReason: "Nearby footprint excluded to avoid counting the wrong structure.",
  };
}

function waitForMapIdle(map: mapboxgl.Map) {
  return new Promise<void>((resolve) => {
    if (map.loaded() && !map.isMoving()) {
      resolve();
      return;
    }

    map.once("idle", () => resolve());
  });
}

function findBuildingFootprints(
  map: mapboxgl.Map,
  coordinates: [number, number],
  parcel: ParcelFeature | null,
): AutoEstimateResult {
  const buildingLayers = map.getLayer(BUILDING_FOOTPRINT_LAYER_ID)
    ? [BUILDING_FOOTPRINT_LAYER_ID]
    : (map
        .getStyle()
        .layers?.filter((layer) => layer.id.toLowerCase().includes("building"))
        .map((layer) => layer.id) ?? []);

  if (buildingLayers.length === 0) {
    return {
      ok: false,
      reason: "No building footprint layer is available in the loaded map style.",
    };
  }

  const centerPoint = map.project(coordinates);
  const parcelBounds = parcel ? turfBbox(parcel) : null;
  const projectedParcelBounds = parcelBounds
    ? [
        map.project([parcelBounds[0], parcelBounds[1]]),
        map.project([parcelBounds[2], parcelBounds[3]]),
      ]
    : null;
  const queryPadding = parcelBounds ? 32 : 130;
  const queryBox: [[number, number], [number, number]] = [
    [
      projectedParcelBounds
        ? Math.min(projectedParcelBounds[0].x, projectedParcelBounds[1].x) - queryPadding
        : centerPoint.x - queryPadding,
      projectedParcelBounds
        ? Math.min(projectedParcelBounds[0].y, projectedParcelBounds[1].y) - queryPadding
        : centerPoint.y - queryPadding,
    ],
    [
      projectedParcelBounds
        ? Math.max(projectedParcelBounds[0].x, projectedParcelBounds[1].x) + queryPadding
        : centerPoint.x + queryPadding,
      projectedParcelBounds
        ? Math.max(projectedParcelBounds[0].y, projectedParcelBounds[1].y) + queryPadding
        : centerPoint.y + queryPadding,
    ],
  ];
  const renderedFeatures = map.queryRenderedFeatures(queryBox, {
    layers: buildingLayers,
  });
  const addressPoint = turfPoint(coordinates);
  const seenGeometries = new Set<string>();
  const candidates = renderedFeatures
    .filter((feature) => isRoofGeometry(feature.geometry))
    .map((feature, index) => {
      const geometry = feature.geometry as Polygon | MultiPolygon;
      const geometryKey = JSON.stringify(geometry.coordinates);

      if (seenGeometries.has(geometryKey)) {
        return null;
      }

      seenGeometries.add(geometryKey);

      const roofFeature: RoofFeature = {
        type: "Feature",
        id: `auto-footprint-${index + 1}`,
        properties: {},
        geometry,
      };
      const roofCenter = turfCenter(roofFeature);
      const containsAddressPoint = booleanPointInPolygon(addressPoint, roofFeature);
      const centerInParcel = parcel ? booleanPointInPolygon(roofCenter, parcel) : false;

      return {
        feature: roofFeature,
        containsAddressPoint,
        centerInParcel,
        areaSqft: turfArea(roofFeature) * SQM_TO_SQFT,
        distanceFromAddressMeters:
          turfDistance(addressPoint, roofCenter, { units: "kilometers" }) * 1000,
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .filter((candidate) => candidate.areaSqft >= 120 && candidate.areaSqft <= 20000)
    .filter((candidate) =>
      parcel ? candidate.containsAddressPoint || candidate.centerInParcel : true,
    )
    .sort((a, b) => {
      if (parcel) {
        if (a.centerInParcel !== b.centerInParcel) {
          return a.centerInParcel ? -1 : 1;
        }

        return b.areaSqft - a.areaSqft;
      }

      if (a.containsAddressPoint !== b.containsAddressPoint) {
        return a.containsAddressPoint ? -1 : 1;
      }

      return a.distanceFromAddressMeters - b.distanceFromAddressMeters;
    });

  if (!candidates[0]) {
    return {
      ok: false,
      reason: "No nearby Mapbox building footprint was found for this Calgary parcel centroid.",
    };
  }

  const mainCandidate = candidates.reduce((best, candidate) => {
    if (!best) {
      return candidate;
    }

    if (parcel) {
      return candidate.areaSqft > best.areaSqft ? candidate : best;
    }

    if (candidate.containsAddressPoint !== best.containsAddressPoint) {
      return candidate.containsAddressPoint ? candidate : best;
    }

    return candidate.distanceFromAddressMeters < best.distanceFromAddressMeters ? candidate : best;
  }, null as (typeof candidates)[number] | null);
  const selectedCandidates = candidates
    .filter((candidate) => candidate === mainCandidate || candidate.areaSqft <= 1100)
    .slice(0, 6);

  const facets = selectedCandidates.map((candidate, index) => {
    const classification = classifyStructure({
      areaSqft: candidate.areaSqft,
      containsAddressPoint: candidate.containsAddressPoint,
      centerInParcel: candidate.centerInParcel,
      isMainCandidate: candidate === mainCandidate,
    });

    return {
      id: `auto-footprint-${index + 1}`,
      feature: {
        ...candidate.feature,
        id: `auto-footprint-${index + 1}`,
        properties: {
          ...(candidate.feature.properties ?? {}),
          distanceFromAddressMeters: candidate.distanceFromAddressMeters,
          centerInParcel: candidate.centerInParcel,
        },
      },
      pitch: DEFAULT_ASSUMPTIONS.pitch,
      included: classification.included,
      source: candidate.containsAddressPoint ? "address" : "nearby",
      role: classification.role,
      includeReason: classification.includeReason,
    };
  }) satisfies Facet[];

  return {
    ok: true,
    facets,
    source:
      facets.length === 1
        ? "Mapbox building footprint selected inside the Calgary parcel."
        : `Found ${facets.length} parcel-filtered Mapbox building footprints. Largest main roof is included; garage-scale secondary footprints are excluded.`,
  };
}

function summarizeFacets({
  facets,
  overhangInches,
  calibrationPercent,
  wasteFactor,
}: {
  facets: Facet[];
  overhangInches: number;
  calibrationPercent: number;
  wasteFactor: number;
}) {
  const includedFacets = facets.filter((facet) => facet.included);
  const buildingFootprintSqft = includedFacets.reduce(
    (sum, facet) => sum + turfArea(facet.feature) * SQM_TO_SQFT,
    0,
  );
  const overhangFootprintSqft = includedFacets.reduce(
    (sum, facet) => sum + turfArea(applyOverhang(facet.feature, overhangInches)) * SQM_TO_SQFT,
    0,
  );
  const roofSqft =
    includedFacets.reduce((sum, facet) => {
      const footprintSqft = turfArea(applyOverhang(facet.feature, overhangInches)) * SQM_TO_SQFT;
      return sum + footprintSqft * pitchMultiplierFor(facet.pitch);
    }, 0) *
    (1 + calibrationPercent / 100);
  const wasteAdjustedSqft = roofSqft * (1 + wasteFactor / 100);

  return {
    buildingFootprintSqft,
    overhangFootprintSqft,
    roofSqft,
    roofingSquares: roofSqft / 100,
    wasteAdjustedSqft,
    includedStructures: includedFacets.length,
    excludedStructures: facets.length - includedFacets.length,
  };
}

function normalizeFacets(
  baseFacets: Facet[],
  assumptions: CommunityAssumptions,
  override: HouseOverride | undefined,
) {
  const pitch = override?.pitch ?? assumptions.pitch;
  const detachedGaragePolicy = override?.detachedGaragePolicy ?? assumptions.detachedGaragePolicy;
  const attachedGaragePolicy = override?.attachedGaragePolicy ?? assumptions.attachedGaragePolicy;

  return baseFacets.map((facet) => {
    const facetOverride = override?.facetOverrides?.[facet.id];
    const isDetached = facet.role === "Detached garage candidate";
    const isAttached = facet.role === "Attached roof candidate";
    const policyIncluded =
      facet.role === "Main roof" ||
      (isAttached && attachedGaragePolicy === "include") ||
      (isDetached && detachedGaragePolicy === "include") ||
      (!isAttached && !isDetached && facet.included);
    const included = facetOverride?.included ?? policyIncluded;

    return {
      ...facet,
      pitch: facetOverride?.pitch ?? pitch,
      included,
      includeReason:
        facetOverride?.included !== undefined
          ? included
            ? "Included by house-level override."
            : "Excluded by house-level override."
          : isDetached
            ? `Detached garage policy is ${detachedGaragePolicy}.`
            : isAttached
              ? `Attached garage policy is ${attachedGaragePolicy}.`
              : facet.includeReason,
    };
  });
}

function buildFlags(
  address: EligibleAddress,
  facets: Facet[],
  sourceMessage: string,
  expectedErrorPercent: number,
) {
  const flags = [classificationLabel(address.subPropertyUse)];

  if (address.dwellingType === "Duplex") {
    flags.push("Duplex counted as one roof estimate");
  }

  if (facets.length > 1) {
    flags.push("Multiple Mapbox building footprints found");
  }

  if (facets.some((facet) => facet.role === "Detached garage candidate" && !facet.included)) {
    flags.push("Detached garage excluded");
  }

  if (facets.some((facet) => facet.role === "Nearby structure")) {
    flags.push("Nearby structure excluded");
  }

  if (sourceMessage) {
    flags.push(sourceMessage);
  }

  if (expectedErrorPercent >= 20) {
    flags.push("Wide expected error band");
  }

  return flags;
}

function buildResult({
  address,
  baseFacets,
  assumptions,
  override,
  sourceMessage,
  status,
}: {
  address: EligibleAddress;
  baseFacets: Facet[];
  assumptions: CommunityAssumptions;
  override?: HouseOverride;
  sourceMessage: string;
  status: EstimateStatus;
}): BatchResult {
  const facets = normalizeFacets(baseFacets, assumptions, override);
  const overhangInches = override?.overhangInches ?? assumptions.overhangInches;
  const calibrationPercent = override?.calibrationPercent ?? assumptions.calibrationPercent;
  const wasteFactor = override?.wasteFactor ?? assumptions.wasteFactor;
  const pitch = override?.pitch ?? assumptions.pitch;
  const detachedGaragePolicy = override?.detachedGaragePolicy ?? assumptions.detachedGaragePolicy;
  const attachedGaragePolicy = override?.attachedGaragePolicy ?? assumptions.attachedGaragePolicy;
  const summary = summarizeFacets({
    facets,
    overhangInches,
    calibrationPercent,
    wasteFactor,
  });
  const baseError =
    status === "Estimated"
      ? address.dwellingType === "Duplex"
        ? 18
        : 14
      : status === "Loaded" || status === "Estimating"
        ? 0
        : 100;
  const expectedErrorPercent =
    baseError +
    (summary.excludedStructures > 2 ? 5 : 0) +
    (address.ageBand === "Unknown" ? 3 : 0) +
    (detachedGaragePolicy === "auto" ? 2 : 0);
  const confidence =
    override?.confidence ??
    (status !== "Estimated"
      ? "Unusable"
      : expectedErrorPercent <= 15
        ? "High"
        : expectedErrorPercent <= 22
          ? "Medium"
          : "Low");
  const assumptionsText = [
    `Community defaults: ${assumptions.pitch} pitch, ${assumptions.overhangInches} inch overhang, ${assumptions.calibrationPercent} percent calibration, ${assumptions.wasteFactor} percent waste.`,
    `Effective house assumptions: ${pitch} pitch, ${overhangInches} inch overhang, ${calibrationPercent} percent calibration, ${wasteFactor} percent waste.`,
    `Attached garage policy ${attachedGaragePolicy}; detached garage policy ${detachedGaragePolicy}.`,
  ];

  if (override && Object.keys(override).length > 0) {
    assumptionsText.push("House-level override saved in localStorage.");
  }

  if (override?.notes?.trim()) {
    assumptionsText.push(`Notes: ${override.notes.trim()}`);
  }

  return {
    id: address.id,
    address,
    baseFacets,
    facets,
    sourceMessage,
    buildingFootprintSqft: summary.buildingFootprintSqft,
    overhangFootprintSqft: summary.overhangFootprintSqft,
    roofSqft: summary.roofSqft,
    roofingSquares: summary.roofingSquares,
    wasteAdjustedSqft: summary.wasteAdjustedSqft,
    pitch,
    overhangInches,
    calibrationPercent,
    wasteFactor,
    detachedGaragePolicy,
    attachedGaragePolicy,
    confidence,
    expectedErrorPercent,
    flags: buildFlags(address, facets, sourceMessage, expectedErrorPercent),
    assumptions: assumptionsText,
    includedStructures: summary.includedStructures,
    excludedStructures: summary.excludedStructures,
    status,
  };
}

function addressFromRow(
  row: CalgaryAssessmentRow,
  seenDuplexKeys: Set<string>,
): EligibleAddress | null {
  const dwellingType = dwellingTypeForCode(row.sub_property_use);

  if (!dwellingType || row.assessment_class !== "RE") {
    return null;
  }

  if (dwellingType === "Duplex") {
    const duplexKey = row.cpid || JSON.stringify(row.multipolygon ?? row.address);

    if (seenDuplexKeys.has(duplexKey)) {
      return null;
    }

    seenDuplexKeys.add(duplexKey);
  }

  const constructionYear = parseYear(row.year_of_construction);
  const multipolygon = normalizeMultiPolygon(row.multipolygon);
  const parcel =
    multipolygon
      ? ({
          type: "Feature",
          id: row.unique_key ?? row.address,
          properties: {
            id: row.unique_key ?? row.address ?? "",
            address: row.address ?? "Unknown address",
            community: row.comm_name ?? "",
            dwellingType,
            ageBand: ageBandFor(constructionYear),
            constructionYear,
            subPropertyUse: row.sub_property_use ?? "",
          },
          geometry: multipolygon,
        } satisfies ParcelFeature)
      : null;
  const parcelCenter = parcel ? turfCenter(parcel) : null;
  const coordinates = parcelCenter?.geometry.coordinates;
  const id = row.unique_key || row.cpid || row.address || crypto.randomUUID();

  return {
    id,
    address: row.address ?? "Unknown address",
    community: row.comm_name ?? "",
    dwellingType,
    classificationSource: classificationLabel(row.sub_property_use),
    constructionYear,
    ageBand: ageBandFor(constructionYear),
    landUse: row.land_use_designation ?? "",
    propertyType: row.property_type ?? "",
    assessmentClass: row.assessment_class ?? "",
    assessmentClassDescription: row.assessment_class_description ?? "",
    subPropertyUse: row.sub_property_use ?? "",
    uniqueKey: row.unique_key ?? "",
    cpid: row.cpid ?? "",
    rollNumber: row.roll_number ?? "",
    latitude: coordinates?.[1] ?? null,
    longitude: coordinates?.[0] ?? null,
    parcel,
    sourceRow: row,
  } satisfies EligibleAddress;
}

function sourceDataForParcels(addresses: EligibleAddress[]) {
  return {
    type: "FeatureCollection",
    features: addresses.flatMap((address) => (address.parcel ? [address.parcel] : [])),
  } satisfies FeatureCollection<MultiPolygon, ParcelProperties>;
}

function fitFeature(map: mapboxgl.Map, feature: Feature) {
  const [minLng, minLat, maxLng, maxLat] = turfBbox(feature);

  map.fitBounds(
    [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
    { padding: 72, maxZoom: 18, duration: 550 },
  );
}

function setGeoJsonSource(map: mapboxgl.Map, sourceId: string, data: FeatureCollection) {
  const source = map.getSource(sourceId);

  if (source && "setData" in source) {
    source.setData(data);
  }
}

export default function RoofCalibrationTool() {
  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [selectedCommunity] = useState("drawn-area");
  const [drawnAreaGeometry, setDrawnAreaGeometry] = useState<Polygon | null>(null);
  const [assumptions, setAssumptions] = useState<CommunityAssumptions>(DEFAULT_ASSUMPTIONS);
  const [eligibleAddresses, setEligibleAddresses] = useState<EligibleAddress[]>([]);
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, HouseOverride>>({});
  const [drawMessage, setDrawMessage] = useState("");
  const [addressMessage, setAddressMessage] = useState("");
  const [batchMessage, setBatchMessage] = useState("");
  const [isLoadingAddresses, setIsLoadingAddresses] = useState(false);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [hiddenAddressColumns, setHiddenAddressColumns] = useState<AddressTableColumnKey[]>([]);
  const [language, setLanguage] = useState<Language>("en");
  const copy = UI_COPY[language];

  const selectedResult =
    batchResults.find((result) => result.id === selectedAddressId) ??
    (selectedAddressId
      ? null
      : batchResults.find((result) => result.status === "Estimated") ?? batchResults[0] ?? null);
  const selectedOverride = selectedResult ? overrides[selectedResult.id] ?? {} : {};
  const estimatedCount = batchResults.filter((result) => result.status === "Estimated").length;
  const visibleAddressColumnCount = 1 + ADDRESS_TABLE_COLUMNS.length - hiddenAddressColumns.length;
  const isAddressColumnVisible = useCallback(
    (key: AddressTableColumnKey) => !hiddenAddressColumns.includes(key),
    [hiddenAddressColumns],
  );
  const noFootprintCount = batchResults.filter((result) => result.status === "No footprint").length;

  const totals = useMemo(() => {
    const estimated = batchResults.filter((result) => result.status === "Estimated");
    const roofSqft = estimated.reduce((sum, result) => sum + result.roofSqft, 0);
    const squares = estimated.reduce((sum, result) => sum + result.roofingSquares, 0);

    return {
      roofSqft,
      squares,
      averageRoofSqft: estimated.length ? roofSqft / estimated.length : 0,
    };
  }, [batchResults]);

  const syncDrawnArea = useCallback(() => {
    const draw = drawRef.current;

    if (!draw) {
      return;
    }

    const polygon = draw
      .getAll()
      .features.find((feature): feature is Feature<Polygon> => feature.geometry.type === "Polygon");

    if (!polygon) {
      setDrawnAreaGeometry(null);
      setDrawMessage("");
      return;
    }

    setDrawnAreaGeometry(polygon.geometry);
    setDrawMessage(
      language === "en"
        ? `Area drawn. Approx ${formatNumber(turfArea(polygon) / 1_000_000, 3)} sq km. Ready to load up to ${MAX_ELIGIBLE_ADDRESSES} eligible houses.`
        : `已圈选区域，约 ${formatNumber(turfArea(polygon) / 1_000_000, 3)} 平方公里。可以载入最多 ${MAX_ELIGIBLE_ADDRESSES} 套住宅。`,
    );
    setEligibleAddresses([]);
    setBatchResults([]);
    setSelectedAddressId(null);
    setAddressMessage("");
    setBatchMessage("");
  }, [language]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(OVERRIDES_STORAGE_KEY);

      if (stored) {
        setOverrides(JSON.parse(stored) as Record<string, HouseOverride>);
      }
    } catch {
      setOverrides({});
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(OVERRIDES_STORAGE_KEY, JSON.stringify(overrides));
  }, [overrides]);

  useEffect(() => {
    if (!mapboxToken || !mapContainerRef.current || mapRef.current) {
      return;
    }

    mapboxgl.accessToken = mapboxToken;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [-114.0719, 51.0447],
      zoom: 10,
      attributionControl: false,
    });

    const draw = new MapboxDraw({
      defaultMode: "simple_select",
      displayControlsDefault: false,
      controls: {
        polygon: true,
        trash: true,
      },
    });

    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-right");
    map.addControl(draw, "top-left");
    mapRef.current = map;
    drawRef.current = draw;

    map.on("load", () => {
      map.addSource(BUILDING_SOURCE_ID, {
        type: "vector",
        url: "mapbox://mapbox.mapbox-streets-v8",
      });
      map.addLayer({
        id: BUILDING_FOOTPRINT_LAYER_ID,
        type: "fill",
        source: BUILDING_SOURCE_ID,
        "source-layer": "building",
        minzoom: 13,
        paint: {
          "fill-color": "#0ea5e9",
          "fill-opacity": 0.16,
          "fill-outline-color": "#0f172a",
        },
      });

      map.addSource(PARCEL_SOURCE_ID, {
        type: "geojson",
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: PARCEL_FILL_LAYER_ID,
        type: "fill",
        source: PARCEL_SOURCE_ID,
        paint: {
          "fill-color": [
            "match",
            ["get", "ageBand"],
            "Pre-1950",
            "#991b1b",
            "1950-1969",
            "#dc2626",
            "1970-1989",
            "#f97316",
            "1990-2009",
            "#eab308",
            "2010+",
            "#22c55e",
            "#64748b",
          ],
          "fill-opacity": [
            "case",
            ["==", ["get", "dwellingType"], "Duplex"],
            0.34,
            0.22,
          ],
        },
      });
      map.addLayer({
        id: PARCEL_LINE_LAYER_ID,
        type: "line",
        source: PARCEL_SOURCE_ID,
        paint: {
          "line-color": [
            "case",
            ["==", ["get", "dwellingType"], "Duplex"],
            "#1d4ed8",
            "#334155",
          ],
          "line-width": [
            "case",
            ["==", ["get", "dwellingType"], "Duplex"],
            1.8,
            0.8,
          ],
          "line-opacity": 0.7,
        },
      });

      map.addSource(SELECTED_PARCEL_SOURCE_ID, {
        type: "geojson",
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: SELECTED_PARCEL_FILL_LAYER_ID,
        type: "fill",
        source: SELECTED_PARCEL_SOURCE_ID,
        paint: {
          "fill-color": "#38bdf8",
          "fill-opacity": 0.24,
        },
      });
      map.addLayer({
        id: SELECTED_PARCEL_LINE_LAYER_ID,
        type: "line",
        source: SELECTED_PARCEL_SOURCE_ID,
        paint: {
          "line-color": "#0369a1",
          "line-width": 3,
        },
      });

      map.addSource(SELECTED_ROOF_SOURCE_ID, {
        type: "geojson",
        data: EMPTY_FEATURE_COLLECTION,
      });
      map.addLayer({
        id: SELECTED_ROOF_FILL_LAYER_ID,
        type: "fill",
        source: SELECTED_ROOF_SOURCE_ID,
        paint: {
          "fill-color": [
            "case",
            ["==", ["get", "included"], true],
            "#facc15",
            "#94a3b8",
          ],
          "fill-opacity": [
            "case",
            ["==", ["get", "included"], true],
            0.48,
            0.18,
          ],
        },
      });
      map.addLayer({
        id: SELECTED_ROOF_LINE_LAYER_ID,
        type: "line",
        source: SELECTED_ROOF_SOURCE_ID,
        paint: {
          "line-color": [
            "case",
            ["==", ["get", "included"], true],
            "#a16207",
            "#475569",
          ],
          "line-width": 2,
        },
      });

      setMapReady(true);
    });

    map.on("draw.create", syncDrawnArea);
    map.on("draw.update", syncDrawnArea);
    map.on("draw.delete", syncDrawnArea);

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      drawRef.current = null;
      mapRef.current = null;
      setMapReady(false);
      map.remove();
    };
  }, [mapboxToken, syncDrawnArea]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !mapReady) {
      return;
    }

    const data = sourceDataForParcels(eligibleAddresses);
    setGeoJsonSource(map, PARCEL_SOURCE_ID, data);

    if (data.features[0]) {
      fitFeature(map, data.features[0]);
    }
  }, [eligibleAddresses, mapReady]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !mapReady || !selectedResult) {
      return;
    }

    setGeoJsonSource(
      map,
      SELECTED_PARCEL_SOURCE_ID,
      selectedResult.address.parcel
        ? {
            type: "FeatureCollection",
            features: [selectedResult.address.parcel],
          }
        : EMPTY_FEATURE_COLLECTION,
    );
    setGeoJsonSource(map, SELECTED_ROOF_SOURCE_ID, {
      type: "FeatureCollection",
      features: selectedResult.facets.map((facet) => ({
        ...facet.feature,
        properties: {
          ...(facet.feature.properties ?? {}),
          role: facet.role,
          included: facet.included,
        },
      })),
    });

    if (selectedResult.address.longitude !== null && selectedResult.address.latitude !== null) {
      markerRef.current?.remove();
      markerRef.current = new mapboxgl.Marker({ color: "#facc15" })
        .setLngLat([selectedResult.address.longitude, selectedResult.address.latitude])
        .addTo(map);
      map.flyTo({
        center: [selectedResult.address.longitude, selectedResult.address.latitude],
        zoom: Math.max(map.getZoom(), 17),
        duration: 600,
      });
    }
  }, [selectedResult, mapReady]);

  useEffect(() => {
    setBatchResults((current) =>
      current.map((result) =>
        buildResult({
          address: result.address,
          baseFacets: result.baseFacets,
          assumptions,
          override: overrides[result.id],
          sourceMessage: result.sourceMessage,
          status: result.status,
        }),
      ),
    );
  }, [assumptions, overrides]);

  const loadEligibleAddresses = async () => {
    if (!drawnAreaGeometry) {
      setAddressMessage(language === "en" ? "Draw an area on the map first." : "请先在地图上圈选区域。");
      return [] satisfies EligibleAddress[];
    }

    setIsLoadingAddresses(true);
    setAddressMessage(
      language === "en"
        ? `Loading up to ${MAX_ELIGIBLE_ADDRESSES} eligible Calgary assessment rows inside the drawn area...`
        : `正在载入圈选区域内最多 ${MAX_ELIGIBLE_ADDRESSES} 条符合条件的卡尔加里评估记录...`,
    );
    setBatchMessage("");
    setSelectedAddressId(null);

    try {
      const drawnWkt = polygonToWkt(drawnAreaGeometry);
      const where = [
        "assessment_class='RE'",
        assumptions.includeDuplexes
          ? "sub_property_use in('R110','R120')"
          : "sub_property_use='R110'",
        `intersects(multipolygon, '${escapeSoqlLiteral(drawnWkt)}')`,
      ].join(" AND ");
      const url = buildSocrataUrl({
        $select:
          "address,comm_name,year_of_construction,land_use_designation,property_type,sub_property_use,assessment_class,assessment_class_description,multipolygon,unique_key,cpid,roll_number",
        $where: where,
        $order: "comm_name,address",
        $limit: MAX_ELIGIBLE_ADDRESSES,
      });
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Calgary address request failed with ${response.status}.`);
      }

      const rows = (await response.json()) as CalgaryAssessmentRow[];
      const seenDuplexKeys = new Set<string>();
      const addresses = rows
        .map((row) => addressFromRow(row, seenDuplexKeys))
        .filter((address): address is EligibleAddress => address !== null);

      setEligibleAddresses(addresses);
      setBatchResults(
        addresses.map((address) =>
          buildResult({
            address,
            baseFacets: [],
            assumptions,
            override: overrides[address.id],
            sourceMessage: "Loaded from Calgary assessment data. Estimate has not been run.",
            status: "Loaded",
          }),
        ),
      );
      setSelectedAddressId(addresses[0]?.id ?? null);
      setAddressMessage(
        language === "en"
          ? `Loaded ${addresses.length} eligible addresses inside the drawn area. Max ${MAX_ELIGIBLE_ADDRESSES}. Filtered to residential R110 single detached${assumptions.includeDuplexes ? " and R120 duplex" : ""} rows only.`
          : `已载入 ${addresses.length} 个符合条件的地址。最多 ${MAX_ELIGIBLE_ADDRESSES} 个；仅筛选住宅 R110 独立屋${assumptions.includeDuplexes ? "和 R120 双拼" : ""}记录。`,
      );
      return addresses;
    } catch (error) {
      setAddressMessage(
        error instanceof Error
          ? error.message
          : language === "en"
            ? "Unable to load eligible Calgary addresses."
            : "无法载入符合条件的卡尔加里地址。",
      );
      return [] satisfies EligibleAddress[];
    } finally {
      setIsLoadingAddresses(false);
    }
  };

  const runBatchEstimate = async (addressesToEstimate = eligibleAddresses) => {
    const map = mapRef.current;

    if (!map || !mapReady || !mapboxToken) {
      setBatchMessage(
        language === "en"
          ? "Mapbox must be loaded before batch estimates can run."
          : "Mapbox 载入完成后才能运行批量估算。",
      );
      return;
    }

    const addresses = addressesToEstimate.length > 0 ? addressesToEstimate : [];

    if (addresses.length === 0) {
      setBatchMessage(
        language === "en" ? "Load eligible addresses first." : "请先载入符合条件的地址。",
      );
      return;
    }

    setIsBatchRunning(true);
    setBatchMessage(
      language === "en"
        ? `Starting ${addresses.length} Mapbox/Turf estimates...`
        : `正在开始 ${addresses.length} 个 Mapbox/Turf 估算...`,
    );

    for (const [index, address] of addresses.entries()) {
      setSelectedAddressId(address.id);
      setBatchResults((current) =>
        current.map((result) =>
          result.id === address.id
            ? buildResult({
                address,
                baseFacets: result.baseFacets,
                assumptions,
                override: overrides[address.id],
                sourceMessage: "Estimating against Mapbox building footprints.",
                status: "Estimating",
              })
            : result,
        ),
      );

      if (address.longitude === null || address.latitude === null) {
        setBatchResults((current) =>
          current.map((result) =>
            result.id === address.id
              ? buildResult({
                  address,
                  baseFacets: [],
                  assumptions,
                  override: overrides[address.id],
                  sourceMessage: "Calgary parcel geometry was missing, so no centroid was available.",
                  status: "No footprint",
                })
              : result,
          ),
        );
        continue;
      }

      try {
        map.jumpTo({
          center: [address.longitude, address.latitude],
          zoom: 18,
        });
        await waitForMapIdle(map);
        await new Promise((resolve) => window.setTimeout(resolve, 120));

        const estimate = findBuildingFootprints(
          map,
          [address.longitude, address.latitude],
          address.parcel,
        );

        setBatchResults((current) =>
          current.map((result) =>
            result.id === address.id
              ? buildResult({
                  address,
                  baseFacets: estimate.ok ? estimate.facets : [],
                  assumptions,
                  override: overrides[address.id],
                  sourceMessage: estimate.ok ? estimate.source : estimate.reason,
                  status: estimate.ok ? "Estimated" : "No footprint",
                })
              : result,
          ),
        );
      } catch (error) {
        setBatchResults((current) =>
          current.map((result) =>
            result.id === address.id
              ? buildResult({
                  address,
                  baseFacets: [],
                  assumptions,
                  override: overrides[address.id],
                  sourceMessage:
                    error instanceof Error ? error.message : "Unexpected estimation error.",
                  status: "Error",
                })
              : result,
          ),
        );
      }

      setBatchMessage(
        language === "en"
          ? `Estimated ${index + 1} of ${addresses.length} addresses.`
          : `已估算 ${index + 1} / ${addresses.length} 个地址。`,
      );
    }

    setIsBatchRunning(false);
    setBatchMessage(
      language === "en"
        ? `Finished ${addresses.length} addresses.`
        : `已完成 ${addresses.length} 个地址。`,
    );
  };

  const loadAndRunEstimate = async () => {
    const addresses = await loadEligibleAddresses();

    if (addresses.length === 0) {
      return;
    }

    await runBatchEstimate(addresses);
  };

  const updateAssumptions = <Key extends keyof CommunityAssumptions>(
    key: Key,
    value: CommunityAssumptions[Key],
  ) => {
    setAssumptions((current) => ({ ...current, [key]: value }));
  };

  const toggleAddressColumn = (key: AddressTableColumnKey) => {
    setHiddenAddressColumns((current) =>
      current.includes(key) ? current.filter((column) => column !== key) : [...current, key],
    );
  };

  const startDrawingArea = () => {
    const draw = drawRef.current;

    if (!draw) {
      setDrawMessage(
        language === "en" ? "Map drawing tools are still loading." : "地图绘制工具仍在载入。",
      );
      return;
    }

    draw.deleteAll();
    draw.changeMode("draw_polygon");
    setDrawnAreaGeometry(null);
    setEligibleAddresses([]);
    setBatchResults([]);
    setSelectedAddressId(null);
    setAddressMessage("");
    setBatchMessage("");
    setDrawMessage(copy.drawActive);
  };

  const clearDrawnArea = () => {
    drawRef.current?.deleteAll();
    markerRef.current?.remove();
    markerRef.current = null;
    setDrawnAreaGeometry(null);
    setEligibleAddresses([]);
    setBatchResults([]);
    setSelectedAddressId(null);
    setAddressMessage("");
    setBatchMessage("");
    setDrawMessage("");
  };

  const updateOverride = (id: string, patch: HouseOverride) => {
    setOverrides((current) => ({
      ...current,
      [id]: {
        ...(current[id] ?? {}),
        ...patch,
        facetOverrides: {
          ...(current[id]?.facetOverrides ?? {}),
          ...(patch.facetOverrides ?? {}),
        },
      },
    }));
  };

  const updateFacetOverride = (
    result: BatchResult,
    facetId: string,
    patch: { included?: boolean; pitch?: PitchValue },
  ) => {
    updateOverride(result.id, {
      facetOverrides: {
        [facetId]: {
          ...(overrides[result.id]?.facetOverrides?.[facetId] ?? {}),
          ...patch,
        },
      },
    });
  };

  const exportBatchCsv = () => {
    const headers = [
      "Source",
      "Community",
      "Address",
      "Unique key",
      "CPID",
      "Roll number",
      "Dwelling type",
      "Classification source",
      "Construction year",
      "Age band",
      "Land use",
      "Property type",
      "Assessment class",
      "Assessment class description",
      "Sub property use",
      "Latitude",
      "Longitude",
      "Default pitch",
      "Effective pitch",
      "Overhang inches",
      "Calibration percent",
      "Detached garage policy",
      "Attached garage policy",
      "Waste factor",
      "Override notes",
      "Override JSON",
      "Building footprint sqft",
      "Overhang footprint sqft",
      "Roof sqft",
      "Roofing squares",
      "Waste adjusted sqft",
      "Confidence",
      "Expected error percent",
      "Included structures",
      "Excluded structures",
      "Flags",
      "Assumptions",
      "Status",
    ];
    const rows = batchResults.map((result) => {
      const override = overrides[result.id] ?? {};

      return [
        "City of Calgary Property Assessments API 4bsw-nn7w",
        result.address.community,
        result.address.address,
        result.address.uniqueKey,
        result.address.cpid,
        result.address.rollNumber,
        result.address.dwellingType,
        result.address.classificationSource,
        result.address.constructionYear ?? "",
        result.address.ageBand,
        result.address.landUse,
        result.address.propertyType,
        result.address.assessmentClass,
        result.address.assessmentClassDescription,
        result.address.subPropertyUse,
        result.address.latitude ?? "",
        result.address.longitude ?? "",
        assumptions.pitch,
        result.pitch,
        result.overhangInches,
        result.calibrationPercent,
        result.detachedGaragePolicy,
        result.attachedGaragePolicy,
        result.wasteFactor,
        override.notes ?? "",
        Object.keys(override).length ? JSON.stringify(override) : "",
        Math.round(result.buildingFootprintSqft),
        Math.round(result.overhangFootprintSqft),
        Math.round(result.roofSqft),
        result.roofingSquares.toFixed(1),
        Math.round(result.wasteAdjustedSqft),
        result.confidence,
        result.expectedErrorPercent,
        result.includedStructures,
        result.excludedStructures,
        result.flags.join("; "),
        result.assumptions.join("; "),
        result.status,
      ];
    });
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => csvEscape(cell)).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `${selectedCommunity.toLowerCase().replaceAll(/[ /]+/g, "-")}-roof-estimates.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="min-h-screen bg-[#eef2ef] text-slate-950">
      <div className="mx-auto flex w-full max-w-[1720px] flex-col gap-3 px-3 py-3 lg:px-4">
        <header className="grid gap-3 border-b border-slate-300 pb-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
          <div>
            <h1 className="text-2xl font-bold tracking-normal text-slate-950">{copy.title}</h1>
            <p className="mt-1 max-w-4xl text-sm font-medium text-slate-600">
              {copy.subtitle}
            </p>
          </div>
          <div className="grid gap-2">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setLanguage((current) => (current === "en" ? "zh" : "en"))}
                className="secondary-button h-9 min-h-9 px-3 text-xs"
                aria-label={copy.languageLabel}
              >
                {copy.languageButton}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-right md:grid-cols-4">
              <Metric label={copy.metrics.eligibleRows} value={formatNumber(eligibleAddresses.length)} />
              <Metric label={copy.metrics.estimated} value={formatNumber(estimatedCount)} />
              <Metric label={copy.metrics.noFootprint} value={formatNumber(noFootprintCount)} />
              <Metric label={copy.metrics.batchSquares} value={formatNumber(totals.squares, 1)} />
            </div>
          </div>
        </header>

        {!mapboxToken ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
            NEXT_PUBLIC_MAPBOX_TOKEN is missing. Add it to .env.local and restart the dev server to enable Mapbox footprint estimates.
          </div>
        ) : null}

        <section className="grid min-w-0 gap-3 xl:grid-cols-[380px_minmax(0,1fr)_360px]">
          <Panel title={copy.drawPanel}>
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={startDrawingArea}
                  disabled={!mapReady}
                  className="primary-button"
                >
                  {copy.drawArea}
                </button>
                <button type="button" onClick={clearDrawnArea} className="secondary-button">
                  {copy.clear}
                </button>
              </div>
              <p className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs font-semibold text-slate-700">
                {drawMessage || copy.drawInstruction}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Readout label={copy.maxLoad} value={`${MAX_ELIGIBLE_ADDRESSES} ${copy.houses}`} strong />
                <Readout
                  label={copy.drawnArea}
                  value={
                    drawnAreaGeometry
                      ? `${formatNumber(
                          turfArea({ type: "Feature", properties: {}, geometry: drawnAreaGeometry }) /
                            1_000_000,
                          3,
                        )} sq km`
                      : copy.none
                  }
                />
                <Readout label={copy.loadedRows} value={formatNumber(eligibleAddresses.length)} />
                <Readout label={copy.selectedSource} value={copy.calgaryOpenData} />
              </div>
            </div>
          </Panel>

          <Panel title={copy.parametersPanel}>
            <div className="grid gap-3 md:grid-cols-4">
              <label className="field-label">
                {copy.defaultPitch}
                <select
                  value={assumptions.pitch}
                  onChange={(event) => updateAssumptions("pitch", event.target.value as PitchValue)}
                  className="control"
                >
                  {PITCH_OPTIONS.map((option) => (
                    <option key={option.label} value={option.label}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                {copy.overhang}
                <input
                  value={assumptions.overhangInches}
                  onChange={(event) =>
                    updateAssumptions("overhangInches", Number(event.target.value))
                  }
                  inputMode="decimal"
                  className="control"
                />
              </label>
              <label className="field-label">
                {copy.calibration}
                <input
                  value={assumptions.calibrationPercent}
                  onChange={(event) =>
                    updateAssumptions("calibrationPercent", Number(event.target.value))
                  }
                  inputMode="decimal"
                  className="control"
                />
              </label>
              <label className="field-label">
                {copy.wasteFactor}
                <input
                  value={assumptions.wasteFactor}
                  onChange={(event) => updateAssumptions("wasteFactor", Number(event.target.value))}
                  inputMode="decimal"
                  className="control"
                />
              </label>
              <label className="field-label">
                {copy.detachedGarage}
                <select
                  value={assumptions.detachedGaragePolicy}
                  onChange={(event) =>
                    updateAssumptions("detachedGaragePolicy", event.target.value as GaragePolicy)
                  }
                  className="control"
                >
                  <option value="exclude">{copy.exclude}</option>
                  <option value="include">{copy.include}</option>
                  <option value="auto">{copy.auto}</option>
                </select>
              </label>
              <label className="field-label">
                {copy.attachedGarage}
                <select
                  value={assumptions.attachedGaragePolicy}
                  onChange={(event) =>
                    updateAssumptions(
                      "attachedGaragePolicy",
                      event.target.value as AttachedGaragePolicy,
                    )
                  }
                  className="control"
                >
                  <option value="include">{copy.include}</option>
                  <option value="exclude">{copy.exclude}</option>
                </select>
              </label>
              <label className="field-label">
                {copy.includeDuplexes}
                <button
                  type="button"
                  onClick={() => updateAssumptions("includeDuplexes", !assumptions.includeDuplexes)}
                  className={`control text-left font-bold ${
                    assumptions.includeDuplexes ? "bg-emerald-50 text-emerald-800" : "bg-white"
                  }`}
                >
                  {assumptions.includeDuplexes ? copy.includeR120 : copy.r110Only}
                </button>
              </label>
              <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs font-semibold text-slate-600">
                {copy.exclusionRule}
              </div>
            </div>
          </Panel>

          <Panel title={copy.loadPanel}>
            <div className="grid gap-2">
              <button
                type="button"
                onClick={() => void loadAndRunEstimate()}
                disabled={!drawnAreaGeometry || isLoadingAddresses || isBatchRunning || !mapReady}
                className="primary-button bg-slate-950 hover:bg-slate-700 disabled:bg-slate-400"
              >
                {isBatchRunning
                  ? copy.runningBatch
                  : isLoadingAddresses
                    ? copy.loadingSelected
                    : copy.loadAndRun}
              </button>
              <button
                type="button"
                onClick={exportBatchCsv}
                disabled={batchResults.length === 0}
                className="secondary-button"
              >
                {copy.exportCsv}
              </button>
              <p className="text-xs font-semibold text-slate-600">{addressMessage}</p>
              <p className="text-xs font-semibold text-slate-600">{batchMessage}</p>
            </div>
          </Panel>
        </section>

        <section className="grid min-w-0 gap-3 xl:grid-cols-[minmax(420px,0.95fr)_minmax(520px,1.05fr)]">
          <Panel title={copy.mapView}>
            <div className="grid min-w-0 gap-2">
              <div className="min-w-0 overflow-hidden rounded-md border border-slate-300 bg-slate-200 shadow-sm">
                {mapboxToken ? (
                  <div ref={mapContainerRef} className="h-[430px] w-full xl:h-[620px]" />
                ) : (
                  <div className="flex h-[430px] items-center justify-center p-6 text-center text-sm font-semibold text-slate-600 xl:h-[620px]">
                    {copy.mapboxRequired}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs font-bold text-slate-700">
                <LegendSwatch color="#991b1b" label="Pre-1950" />
                <LegendSwatch color="#dc2626" label="1950-1969" />
                <LegendSwatch color="#f97316" label="1970-1989" />
                <LegendSwatch color="#eab308" label="1990-2009" />
                <LegendSwatch color="#22c55e" label="2010+" />
                <span className="ml-auto text-slate-500">{copy.duplexLegend}</span>
              </div>
            </div>
          </Panel>

          <Panel title={copy.addressTable}>
            <div className="grid min-w-0 gap-2">
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-2">
                <span className="text-xs font-bold uppercase tracking-normal text-slate-500">
                  {copy.columns}
                </span>
                {ADDRESS_TABLE_COLUMNS.map((column) => (
                  <button
                    key={column.key}
                    type="button"
                    onClick={() => toggleAddressColumn(column.key)}
                    className={`h-8 rounded-md border px-2 text-xs font-bold ${
                      isAddressColumnVisible(column.key)
                        ? "border-sky-200 bg-sky-50 text-sky-800"
                        : "border-slate-200 bg-white text-slate-500"
                    }`}
                    aria-pressed={isAddressColumnVisible(column.key)}
                  >
                    {column.label[language]}
                  </button>
                ))}
              </div>

              <div className="max-h-[620px] overflow-auto rounded-md border border-slate-200">
                <table className="address-table w-full min-w-[980px] border-collapse text-left text-xs">
                  <thead className="sticky top-0 z-20 bg-slate-50 uppercase tracking-normal text-slate-500">
                    <tr className="border-b border-slate-200">
                      <TableHeader sticky>{copy.address}</TableHeader>
                      {isAddressColumnVisible("dwellingType") ? (
                        <TableHeader>{ADDRESS_TABLE_COLUMNS[0].label[language]}</TableHeader>
                      ) : null}
                      {isAddressColumnVisible("year") ? (
                        <TableHeader>{ADDRESS_TABLE_COLUMNS[1].label[language]}</TableHeader>
                      ) : null}
                      {isAddressColumnVisible("ageBand") ? (
                        <TableHeader>{ADDRESS_TABLE_COLUMNS[2].label[language]}</TableHeader>
                      ) : null}
                      {isAddressColumnVisible("landUse") ? (
                        <TableHeader>{ADDRESS_TABLE_COLUMNS[3].label[language]}</TableHeader>
                      ) : null}
                      {isAddressColumnVisible("roofSqft") ? (
                        <TableHeader>{ADDRESS_TABLE_COLUMNS[4].label[language]}</TableHeader>
                      ) : null}
                      {isAddressColumnVisible("squares") ? (
                        <TableHeader>{ADDRESS_TABLE_COLUMNS[5].label[language]}</TableHeader>
                      ) : null}
                      {isAddressColumnVisible("confidence") ? (
                        <TableHeader>{ADDRESS_TABLE_COLUMNS[6].label[language]}</TableHeader>
                      ) : null}
                      {isAddressColumnVisible("expectedError") ? (
                        <TableHeader>{ADDRESS_TABLE_COLUMNS[7].label[language]}</TableHeader>
                      ) : null}
                      {isAddressColumnVisible("flags") ? (
                        <TableHeader>{ADDRESS_TABLE_COLUMNS[8].label[language]}</TableHeader>
                      ) : null}
                      {isAddressColumnVisible("status") ? (
                        <TableHeader>{ADDRESS_TABLE_COLUMNS[9].label[language]}</TableHeader>
                      ) : null}
                      {isAddressColumnVisible("view") ? (
                        <TableHeader>{ADDRESS_TABLE_COLUMNS[10].label[language]}</TableHeader>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {batchResults.length === 0 ? (
                      <tr>
                        <td
                          colSpan={visibleAddressColumnCount}
                          className="px-3 py-7 text-center text-sm text-slate-500"
                        >
                          {copy.emptyTable}
                        </td>
                      </tr>
                    ) : null}
                    {batchResults.map((result) => (
                      <tr
                        key={result.id}
                        className={`border-b border-slate-100 ${
                          selectedResult?.id === result.id ? "bg-cyan-50" : "hover:bg-slate-50"
                        }`}
                      >
                        <TableCell sticky>
                          <span className="block max-w-[220px] truncate font-bold text-slate-950">
                            {result.address.address}
                          </span>
                        </TableCell>
                        {isAddressColumnVisible("dwellingType") ? (
                          <TableCell>
                            <span
                              className={`rounded-md border px-2 py-1 text-[11px] font-bold ${
                                result.address.dwellingType === "Duplex"
                                  ? "border-blue-200 bg-blue-50 text-blue-800"
                                  : "border-slate-200 bg-white text-slate-700"
                              }`}
                            >
                              {localizeDwellingType(result.address.dwellingType, language)}
                            </span>
                          </TableCell>
                        ) : null}
                        {isAddressColumnVisible("year") ? (
                          <TableCell>{result.address.constructionYear ?? copy.unknown}</TableCell>
                        ) : null}
                        {isAddressColumnVisible("ageBand") ? (
                          <TableCell>{result.address.ageBand}</TableCell>
                        ) : null}
                        {isAddressColumnVisible("landUse") ? (
                          <TableCell>{result.address.landUse || copy.unknown}</TableCell>
                        ) : null}
                        {isAddressColumnVisible("roofSqft") ? (
                          <TableCell>
                            {result.roofSqft
                              ? `${formatNumber(result.roofSqft)} ${copy.sqft}`
                              : "-"}
                          </TableCell>
                        ) : null}
                        {isAddressColumnVisible("squares") ? (
                          <TableCell>
                            {result.roofingSquares ? formatNumber(result.roofingSquares, 1) : "-"}
                          </TableCell>
                        ) : null}
                        {isAddressColumnVisible("confidence") ? (
                          <TableCell>{localizeConfidence(result.confidence, language)}</TableCell>
                        ) : null}
                        {isAddressColumnVisible("expectedError") ? (
                          <TableCell>
                            {result.expectedErrorPercent
                              ? `+/- ${formatNumber(result.expectedErrorPercent)}%`
                              : "-"}
                          </TableCell>
                        ) : null}
                        {isAddressColumnVisible("flags") ? (
                          <TableCell>
                            <span className="block max-w-[260px] truncate">
                              {result.flags.join("; ")}
                            </span>
                          </TableCell>
                        ) : null}
                        {isAddressColumnVisible("status") ? (
                          <TableCell>{localizeStatus(result.status, language)}</TableCell>
                        ) : null}
                        {isAddressColumnVisible("view") ? (
                          <TableCell>
                            <button
                              type="button"
                              onClick={() => setSelectedAddressId(result.id)}
                              className="secondary-button h-8 px-2 text-xs"
                            >
                              {copy.viewButton}
                            </button>
                          </TableCell>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Panel>
        </section>

        <section className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)]">
          <aside className="grid min-w-0 content-start gap-3">
            <Panel title={copy.selectedAddress}>
              {selectedResult ? (
                <div className="grid gap-3">
                  <div>
                    <h2 className="text-base font-bold text-slate-950">
                      {selectedResult.address.address}
                    </h2>
                    <p className="text-xs font-semibold text-slate-600">
                      {selectedResult.address.community} /{" "}
                      {localizeDwellingType(selectedResult.address.dwellingType, language)} /{" "}
                      {selectedResult.address.classificationSource}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <Readout
                      label={copy.roofSqft}
                      value={`${formatNumber(selectedResult.roofSqft)} ${copy.sqft}`}
                      strong
                    />
                    <Readout
                      label={copy.roofingSquares}
                      value={formatNumber(selectedResult.roofingSquares, 1)}
                    />
                    <Readout
                      label={copy.confidence}
                      value={`${localizeConfidence(selectedResult.confidence, language)} +/- ${formatNumber(
                        selectedResult.expectedErrorPercent,
                      )}%`}
                    />
                    <Readout
                      label={copy.structures}
                      value={
                        language === "en"
                          ? `${selectedResult.includedStructures} ${copy.inOut.replace(
                              "{out}",
                              String(selectedResult.excludedStructures),
                            )}`
                          : `${copy.included} ${selectedResult.includedStructures} / ${copy.excluded} ${selectedResult.excludedStructures}`
                      }
                    />
                  </div>

                  <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs font-semibold text-slate-700">
                    <p>{copy.source}: City of Calgary Property Assessments API 4bsw-nn7w.</p>
                    <p>
                      {copy.landUse} {selectedResult.address.landUse || copy.unknown},{" "}
                      {copy.assessment}{" "}
                      {selectedResult.address.assessmentClassDescription || copy.unknown},{" "}
                      {copy.uniqueKey} {selectedResult.address.uniqueKey || copy.notSupplied}.
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="field-label">
                      {copy.pitchOverride}
                      <select
                        value={selectedOverride.pitch ?? selectedResult.pitch}
                        onChange={(event) =>
                          updateOverride(selectedResult.id, {
                            pitch: event.target.value as PitchValue,
                          })
                        }
                        className="control"
                      >
                        {PITCH_OPTIONS.map((option) => (
                          <option key={option.label} value={option.label}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-label">
                      {copy.overhang}
                      <input
                        value={selectedOverride.overhangInches ?? selectedResult.overhangInches}
                        onChange={(event) =>
                          updateOverride(selectedResult.id, {
                            overhangInches: Number(event.target.value),
                          })
                        }
                        inputMode="decimal"
                        className="control"
                      />
                    </label>
                    <label className="field-label">
                      {copy.calibration}
                      <input
                        value={
                          selectedOverride.calibrationPercent ?? selectedResult.calibrationPercent
                        }
                        onChange={(event) =>
                          updateOverride(selectedResult.id, {
                            calibrationPercent: Number(event.target.value),
                          })
                        }
                        inputMode="decimal"
                        className="control"
                      />
                    </label>
                    <label className="field-label">
                      {copy.confidence}
                      <select
                        value={selectedOverride.confidence ?? selectedResult.confidence}
                        onChange={(event) =>
                          updateOverride(selectedResult.id, {
                            confidence: event.target.value as Confidence,
                          })
                        }
                        className="control"
                      >
                        {["High", "Medium", "Low", "Unusable"].map((confidence) => (
                          <option key={confidence} value={confidence}>
                            {localizeConfidence(confidence as Confidence, language)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-label">
                      {copy.detachedGarage}
                      <select
                        value={
                          selectedOverride.detachedGaragePolicy ??
                          selectedResult.detachedGaragePolicy
                        }
                        onChange={(event) =>
                          updateOverride(selectedResult.id, {
                            detachedGaragePolicy: event.target.value as GaragePolicy,
                          })
                        }
                        className="control"
                      >
                        <option value="exclude">{copy.exclude}</option>
                        <option value="include">{copy.include}</option>
                        <option value="auto">{copy.auto}</option>
                      </select>
                    </label>
                    <label className="field-label">
                      {copy.attachedGarage}
                      <select
                        value={
                          selectedOverride.attachedGaragePolicy ??
                          selectedResult.attachedGaragePolicy
                        }
                        onChange={(event) =>
                          updateOverride(selectedResult.id, {
                            attachedGaragePolicy: event.target.value as AttachedGaragePolicy,
                          })
                        }
                        className="control"
                      >
                        <option value="include">{copy.include}</option>
                        <option value="exclude">{copy.exclude}</option>
                      </select>
                    </label>
                  </div>

                  <label className="field-label">
                    {copy.notes}
                    <textarea
                      value={selectedOverride.notes ?? ""}
                      onChange={(event) =>
                        updateOverride(selectedResult.id, { notes: event.target.value })
                      }
                      rows={3}
                      className="control min-h-20 resize-y py-2"
                      placeholder={copy.notesPlaceholder}
                    />
                  </label>

                  <div className="grid gap-2">
                    <h3 className="text-xs font-bold uppercase tracking-normal text-slate-500">
                      {copy.roofStructures}
                    </h3>
                    {selectedResult.facets.length === 0 ? (
                      <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs font-semibold text-amber-900">
                        {copy.noFootprintAttached}
                      </div>
                    ) : null}
                    {selectedResult.facets.map((facet, index) => (
                      <div
                        key={facet.id}
                        className="grid gap-2 rounded-md border border-slate-200 bg-white p-2"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-xs font-bold text-slate-950">
                              {copy.structure} {index + 1}: {facet.role}
                            </p>
                            <p className="text-[11px] font-semibold text-slate-500">
                              {facet.includeReason}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              updateFacetOverride(selectedResult, facet.id, {
                                included: !facet.included,
                              })
                            }
                            className={`h-8 rounded-md border px-2 text-xs font-bold ${
                              facet.included
                                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                                : "border-slate-200 bg-slate-50 text-slate-500"
                            }`}
                          >
                            {facet.included ? copy.included : copy.excluded}
                          </button>
                        </div>
                        <select
                          value={facet.pitch}
                          onChange={(event) =>
                            updateFacetOverride(selectedResult, facet.id, {
                              pitch: event.target.value as PitchValue,
                            })
                          }
                          className="control h-8"
                        >
                          {PITCH_OPTIONS.map((option) => (
                            <option key={option.label} value={option.label}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>

                  <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
                    <p className="text-xs font-bold uppercase tracking-normal text-slate-500">
                      {copy.flags}
                    </p>
                    <p className="text-xs font-semibold text-slate-700">
                      {selectedResult.flags.join("; ")}
                    </p>
                    <p className="mt-2 text-xs font-bold uppercase tracking-normal text-slate-500">
                      {copy.assumptions}
                    </p>
                    <p className="text-xs font-semibold text-slate-700">
                      {selectedResult.assumptions.join("; ")}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm font-medium text-slate-600">
                  {copy.selectedEmpty}
                </p>
              )}
            </Panel>
          </aside>
        </section>
      </div>
    </main>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-md border border-slate-200 bg-white p-3 shadow-sm">
      <h2 className="mb-2 text-xs font-bold uppercase tracking-normal text-slate-600">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm">
      <div className="text-[11px] font-bold uppercase tracking-normal text-slate-500">
        {label}
      </div>
      <div className="mt-1 text-sm font-bold text-slate-950">{value}</div>
    </div>
  );
}

function Readout({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-2">
      <div className="text-[11px] font-bold uppercase tracking-normal text-slate-500">
        {label}
      </div>
      <div
        className={`mt-1 leading-tight ${
          strong ? "text-lg font-bold text-slate-950" : "text-sm font-semibold text-slate-800"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function TableHeader({ children, sticky = false }: { children: React.ReactNode; sticky?: boolean }) {
  return (
    <th
      className={`whitespace-nowrap px-3 py-2 font-bold ${
        sticky ? "sticky left-0 z-30 min-w-[190px] bg-slate-50 shadow-[1px_0_0_#e2e8f0]" : ""
      }`}
    >
      {children}
    </th>
  );
}

function TableCell({ children, sticky = false }: { children: React.ReactNode; sticky?: boolean }) {
  return (
    <td
      className={`whitespace-nowrap px-3 py-2 align-middle text-slate-700 ${
        sticky ? "sticky left-0 z-10 min-w-[190px] bg-inherit shadow-[1px_0_0_#e2e8f0]" : ""
      }`}
    >
      {children}
    </td>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="h-3 w-3 rounded-sm border border-slate-300" style={{ background: color }} />
      {label}
    </span>
  );
}
