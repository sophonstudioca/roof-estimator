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
  multipolygon?: MultiPolygon;
  unique_key?: string;
  cpid?: string;
  roll_number?: string;
};

type GroupedSummaryRow = {
  comm_name?: string;
  sub_property_use?: string;
  year_of_construction?: string;
  count?: string;
};

type AgeTypeBreakdown = Record<AgeBand, Record<DwellingType, number>>;

type CommunitySummary = {
  community: string;
  singleDetachedCount: number;
  duplexCount: number;
  total: number;
  averageYear: number | null;
  oldestYear: number | null;
  priorityScore: number;
  ageTypeBreakdown: AgeTypeBreakdown;
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

const SOCRATA_ENDPOINT = "https://data.calgary.ca/resource/4bsw-nn7w.json";
const SQM_TO_SQFT = 10.7639;
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

const AGE_BANDS: AgeBand[] = [
  "Pre-1950",
  "1950-1969",
  "1970-1989",
  "1990-2009",
  "2010+",
  "Unknown",
];

function pitchMultiplierFor(pitch: PitchValue) {
  return PITCH_OPTIONS.find((option) => option.label === pitch)?.multiplier ?? 1.118;
}

function formatNumber(value: number, digits = 0) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
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

function createEmptyBreakdown(): AgeTypeBreakdown {
  return AGE_BANDS.reduce((bands, band) => {
    bands[band] = {
      "Single detached": 0,
      Duplex: 0,
    };
    return bands;
  }, {} as AgeTypeBreakdown);
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
  distanceFromAddressMeters,
  containsAddressPoint,
  index,
}: {
  areaSqft: number;
  distanceFromAddressMeters: number;
  containsAddressPoint: boolean;
  index: number;
}): { role: StructureRole; included: boolean; includeReason: string } {
  if (index === 0) {
    return {
      role: "Main roof",
      included: true,
      includeReason: containsAddressPoint
        ? "Closest footprint contains the Calgary parcel centroid."
        : "Closest footprint to the Calgary parcel centroid.",
    };
  }

  if (areaSqft < 220) {
    return {
      role: "Small outbuilding",
      included: false,
      includeReason: "Small nearby footprint excluded from the automatic total.",
    };
  }

  if (distanceFromAddressMeters <= 16 && areaSqft >= 280 && areaSqft <= 1200) {
    return {
      role: "Attached roof candidate",
      included: true,
      includeReason: "Close garage-scale footprint included as likely attached roof area.",
    };
  }

  if (areaSqft >= 280 && areaSqft <= 1100) {
    return {
      role: "Detached garage candidate",
      included: false,
      includeReason: "Garage-scale footprint excluded unless detached garages are included.",
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
  const queryBox: [[number, number], [number, number]] = [
    [centerPoint.x - 130, centerPoint.y - 130],
    [centerPoint.x + 130, centerPoint.y + 130],
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

      return {
        feature: roofFeature,
        containsAddressPoint: booleanPointInPolygon(addressPoint, roofFeature),
        areaSqft: turfArea(roofFeature) * SQM_TO_SQFT,
        distanceFromAddressMeters:
          turfDistance(addressPoint, turfCenter(roofFeature), { units: "kilometers" }) * 1000,
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .filter((candidate) => candidate.areaSqft >= 120 && candidate.areaSqft <= 20000)
    .sort((a, b) => {
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

  const selectedCandidates = candidates
    .filter(
      (candidate, index) =>
        index === 0 ||
        candidate.containsAddressPoint ||
        candidate.distanceFromAddressMeters <= 45,
    )
    .slice(0, 6);

  const facets = selectedCandidates.map((candidate, index) => {
    const classification = classifyStructure({
      areaSqft: candidate.areaSqft,
      distanceFromAddressMeters: candidate.distanceFromAddressMeters,
      containsAddressPoint: candidate.containsAddressPoint,
      index,
    });

    return {
      id: `auto-footprint-${index + 1}`,
      feature: {
        ...candidate.feature,
        id: `auto-footprint-${index + 1}`,
        properties: {
          ...(candidate.feature.properties ?? {}),
          distanceFromAddressMeters: candidate.distanceFromAddressMeters,
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
        ? "Mapbox building footprint found at the Calgary parcel centroid."
        : `Found ${facets.length} nearby Mapbox building footprints. Closest structure is included by default.`,
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
    const duplexKey = row.cpid || JSON.stringify(row.multipolygon?.coordinates ?? row.address);

    if (seenDuplexKeys.has(duplexKey)) {
      return null;
    }

    seenDuplexKeys.add(duplexKey);
  }

  const constructionYear = parseYear(row.year_of_construction);
  const parcel =
    row.multipolygon?.type === "MultiPolygon"
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
          geometry: row.multipolygon,
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
  const [mapReady, setMapReady] = useState(false);
  const [communitySummaries, setCommunitySummaries] = useState<CommunitySummary[]>([]);
  const [selectedCommunity, setSelectedCommunity] = useState("");
  const [assumptions, setAssumptions] = useState<CommunityAssumptions>(DEFAULT_ASSUMPTIONS);
  const [eligibleAddresses, setEligibleAddresses] = useState<EligibleAddress[]>([]);
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, HouseOverride>>({});
  const [communityMessage, setCommunityMessage] = useState("Loading Calgary community summaries...");
  const [addressMessage, setAddressMessage] = useState("");
  const [batchMessage, setBatchMessage] = useState("");
  const [isLoadingCommunities, setIsLoadingCommunities] = useState(true);
  const [isLoadingAddresses, setIsLoadingAddresses] = useState(false);
  const [isBatchRunning, setIsBatchRunning] = useState(false);

  const selectedSummary =
    communitySummaries.find((summary) => summary.community === selectedCommunity) ?? null;
  const selectedResult =
    batchResults.find((result) => result.id === selectedAddressId) ??
    (selectedAddressId
      ? null
      : batchResults.find((result) => result.status === "Estimated") ?? batchResults[0] ?? null);
  const selectedOverride = selectedResult ? overrides[selectedResult.id] ?? {} : {};
  const estimatedCount = batchResults.filter((result) => result.status === "Estimated").length;
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

  const fetchCommunitySummaries = useCallback(async () => {
    setIsLoadingCommunities(true);
    setCommunityMessage("Loading Calgary community summaries...");

    try {
      const url = buildSocrataUrl({
        $select: "comm_name,sub_property_use,year_of_construction,count(*) as count",
        $where:
          "assessment_class='RE' AND sub_property_use in('R110','R120') AND year_of_construction IS NOT NULL",
        $group: "comm_name,sub_property_use,year_of_construction",
        $limit: 50000,
      });
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Calgary data request failed with ${response.status}.`);
      }

      const rows = (await response.json()) as GroupedSummaryRow[];
      const summaries = new Map<string, CommunitySummary & { weightedYearTotal: number }>();

      rows.forEach((row) => {
        const community = row.comm_name?.trim();
        const dwellingType = dwellingTypeForCode(row.sub_property_use);
        const year = parseYear(row.year_of_construction);
        const count = Number(row.count ?? 0);

        if (!community || !dwellingType || !Number.isFinite(count) || count <= 0) {
          return;
        }

        const current =
          summaries.get(community) ??
          ({
            community,
            singleDetachedCount: 0,
            duplexCount: 0,
            total: 0,
            averageYear: null,
            oldestYear: null,
            priorityScore: 0,
            ageTypeBreakdown: createEmptyBreakdown(),
            weightedYearTotal: 0,
          } satisfies CommunitySummary & { weightedYearTotal: number });
        const band = ageBandFor(year);

        current.total += count;
        current.weightedYearTotal += (year ?? 0) * count;
        current.oldestYear =
          year === null
            ? current.oldestYear
            : current.oldestYear === null
              ? year
              : Math.min(current.oldestYear, year);

        if (dwellingType === "Single detached") {
          current.singleDetachedCount += count;
        } else {
          current.duplexCount += count;
        }

        current.ageTypeBreakdown[band][dwellingType] += count;
        summaries.set(community, current);
      });

      const processed = Array.from(summaries.values())
        .map((summary) => {
          const olderCount =
            summary.ageTypeBreakdown["Pre-1950"]["Single detached"] +
            summary.ageTypeBreakdown["Pre-1950"].Duplex +
            summary.ageTypeBreakdown["1950-1969"]["Single detached"] +
            summary.ageTypeBreakdown["1950-1969"].Duplex +
            summary.ageTypeBreakdown["1970-1989"]["Single detached"] +
            summary.ageTypeBreakdown["1970-1989"].Duplex;
          const averageYear = summary.total ? summary.weightedYearTotal / summary.total : null;

          return {
            community: summary.community,
            singleDetachedCount: summary.singleDetachedCount,
            duplexCount: summary.duplexCount,
            total: summary.total,
            averageYear,
            oldestYear: summary.oldestYear,
            priorityScore: olderCount * 2 + summary.total * 0.2 - (averageYear ?? 2026),
            ageTypeBreakdown: summary.ageTypeBreakdown,
          } satisfies CommunitySummary;
        })
        .filter((summary) => summary.total >= 50)
        .sort((a, b) => b.priorityScore - a.priorityScore);

      setCommunitySummaries(processed);
      setSelectedCommunity((current) => current || processed[0]?.community || "");
      setCommunityMessage(
        `Loaded ${processed.length} Calgary communities. Sorted by older construction stock and eligible detached/duplex count.`,
      );
    } catch (error) {
      setCommunityMessage(
        error instanceof Error
          ? error.message
          : "Unable to load Calgary community summaries from open data.",
      );
    } finally {
      setIsLoadingCommunities(false);
    }
  }, []);

  useEffect(() => {
    void fetchCommunitySummaries();
  }, [fetchCommunitySummaries]);

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

    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-right");
    mapRef.current = map;

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

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      mapRef.current = null;
      setMapReady(false);
      map.remove();
    };
  }, [mapboxToken]);

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
    if (!selectedCommunity) {
      return;
    }

    setIsLoadingAddresses(true);
    setAddressMessage("Loading eligible Calgary assessment rows...");
    setBatchMessage("");
    setSelectedAddressId(null);

    try {
      const where = [
        `comm_name='${escapeSoqlLiteral(selectedCommunity)}'`,
        "assessment_class='RE'",
        assumptions.includeDuplexes
          ? "sub_property_use in('R110','R120')"
          : "sub_property_use='R110'",
      ].join(" AND ");
      const url = buildSocrataUrl({
        $select:
          "address,comm_name,year_of_construction,land_use_designation,property_type,sub_property_use,assessment_class,assessment_class_description,multipolygon,unique_key,cpid,roll_number",
        $where: where,
        $order: "address",
        $limit: 5000,
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
        `Loaded ${addresses.length} eligible addresses from Calgary open data. Filtered to residential R110 single detached${assumptions.includeDuplexes ? " and R120 duplex" : ""} rows only.`,
      );
    } catch (error) {
      setAddressMessage(
        error instanceof Error
          ? error.message
          : "Unable to load eligible Calgary addresses.",
      );
    } finally {
      setIsLoadingAddresses(false);
    }
  };

  const runBatchEstimate = async () => {
    const map = mapRef.current;

    if (!map || !mapReady || !mapboxToken) {
      setBatchMessage("Mapbox must be loaded before batch estimates can run.");
      return;
    }

    const addresses = eligibleAddresses.length > 0 ? eligibleAddresses : [];

    if (addresses.length === 0) {
      setBatchMessage("Load eligible addresses first.");
      return;
    }

    setIsBatchRunning(true);
    setBatchMessage(`Starting ${addresses.length} Mapbox/Turf estimates...`);

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

        const estimate = findBuildingFootprints(map, [address.longitude, address.latitude]);

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

      setBatchMessage(`Estimated ${index + 1} of ${addresses.length} addresses.`);
    }

    setIsBatchRunning(false);
    setBatchMessage(`Finished ${addresses.length} addresses.`);
  };

  const updateAssumptions = <Key extends keyof CommunityAssumptions>(
    key: Key,
    value: CommunityAssumptions[Key],
  ) => {
    setAssumptions((current) => ({ ...current, [key]: value }));
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
            <h1 className="text-2xl font-bold tracking-normal text-slate-950">
              Roof Sqft Calibration Tool
            </h1>
            <p className="mt-1 max-w-4xl text-sm font-medium text-slate-600">
              Calgary community batch estimator using City of Calgary assessment parcels, inferred
              R110/R120 dwelling type, Mapbox building footprints, and Turf area calculations.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-right md:grid-cols-4">
            <Metric label="Eligible rows" value={formatNumber(eligibleAddresses.length)} />
            <Metric label="Estimated" value={formatNumber(estimatedCount)} />
            <Metric label="No footprint" value={formatNumber(noFootprintCount)} />
            <Metric label="Batch squares" value={formatNumber(totals.squares, 1)} />
          </div>
        </header>

        {!mapboxToken ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
            NEXT_PUBLIC_MAPBOX_TOKEN is missing. Add it to .env.local and restart the dev server to enable Mapbox footprint estimates.
          </div>
        ) : null}

        <section className="grid min-w-0 gap-3 xl:grid-cols-[380px_minmax(0,1fr)_360px]">
          <Panel title="1. Select community">
            <div className="grid gap-3">
              <label className="field-label">
                Community
                <select
                  value={selectedCommunity}
                  onChange={(event) => {
                    setSelectedCommunity(event.target.value);
                    setEligibleAddresses([]);
                    setBatchResults([]);
                    setSelectedAddressId(null);
                    setAddressMessage("");
                  }}
                  disabled={isLoadingCommunities}
                  className="control"
                >
                  {communitySummaries.map((summary) => (
                    <option key={summary.community} value={summary.community}>
                      {summary.community} ({formatNumber(summary.total)})
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs font-semibold text-slate-600">{communityMessage}</p>

              {selectedSummary ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <Readout label="Eligible homes" value={formatNumber(selectedSummary.total)} strong />
                    <Readout
                      label="Avg build year"
                      value={
                        selectedSummary.averageYear
                          ? formatNumber(selectedSummary.averageYear)
                          : "Unknown"
                      }
                    />
                    <Readout
                      label="Single detached"
                      value={formatNumber(selectedSummary.singleDetachedCount)}
                    />
                    <Readout label="Duplexes" value={formatNumber(selectedSummary.duplexCount)} />
                    <Readout
                      label="Oldest row"
                      value={selectedSummary.oldestYear ? String(selectedSummary.oldestYear) : "Unknown"}
                    />
                    <Readout
                      label="Priority score"
                      value={formatNumber(selectedSummary.priorityScore)}
                    />
                  </div>
                  <AgeBreakdownTable summary={selectedSummary} />
                </>
              ) : null}
            </div>
          </Panel>

          <Panel title="2. Community parameters">
            <div className="grid gap-3 md:grid-cols-4">
              <label className="field-label">
                Default pitch
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
                Overhang inches
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
                Calibration percent
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
                Waste factor
                <input
                  value={assumptions.wasteFactor}
                  onChange={(event) => updateAssumptions("wasteFactor", Number(event.target.value))}
                  inputMode="decimal"
                  className="control"
                />
              </label>
              <label className="field-label">
                Detached garage
                <select
                  value={assumptions.detachedGaragePolicy}
                  onChange={(event) =>
                    updateAssumptions("detachedGaragePolicy", event.target.value as GaragePolicy)
                  }
                  className="control"
                >
                  <option value="exclude">Exclude</option>
                  <option value="include">Include</option>
                  <option value="auto">Auto</option>
                </select>
              </label>
              <label className="field-label">
                Attached garage
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
                  <option value="include">Include</option>
                  <option value="exclude">Exclude</option>
                </select>
              </label>
              <label className="field-label">
                Include duplexes
                <button
                  type="button"
                  onClick={() => updateAssumptions("includeDuplexes", !assumptions.includeDuplexes)}
                  className={`control text-left font-bold ${
                    assumptions.includeDuplexes ? "bg-emerald-50 text-emerald-800" : "bg-white"
                  }`}
                >
                  {assumptions.includeDuplexes ? "Yes, include R120" : "No, R110 only"}
                </button>
              </label>
              <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs font-semibold text-slate-600">
                Exclusion rule: townhouse, rowhouse, condo, apartment, commercial, industrial,
                multi-unit, and non-residential rows are excluded because only RE + R110/R120 rows
                are loaded.
              </div>
            </div>
          </Panel>

          <Panel title="3. Load and run">
            <div className="grid gap-2">
              <button
                type="button"
                onClick={() => void loadEligibleAddresses()}
                disabled={!selectedCommunity || isLoadingAddresses}
                className="primary-button"
              >
                {isLoadingAddresses ? "Loading addresses" : "Load eligible addresses"}
              </button>
              <button
                type="button"
                onClick={() => void runBatchEstimate()}
                disabled={isBatchRunning || eligibleAddresses.length === 0 || !mapReady}
                className="primary-button bg-slate-950 hover:bg-slate-700 disabled:bg-slate-400"
              >
                {isBatchRunning ? "Running batch estimate" : "Run batch estimate"}
              </button>
              <button
                type="button"
                onClick={exportBatchCsv}
                disabled={batchResults.length === 0}
                className="secondary-button"
              >
                Export CSV
              </button>
              <p className="text-xs font-semibold text-slate-600">{addressMessage}</p>
              <p className="text-xs font-semibold text-slate-600">{batchMessage}</p>
            </div>
          </Panel>
        </section>

        <section className="grid min-w-0 min-h-[680px] gap-3 xl:grid-cols-[minmax(0,1fr)_430px]">
          <div className="grid min-w-0 gap-3">
            <div className="min-w-0 overflow-hidden rounded-md border border-slate-300 bg-slate-200 shadow-sm">
              {mapboxToken ? (
                <div ref={mapContainerRef} className="h-[420px] w-full lg:h-[520px]" />
              ) : (
                <div className="flex h-[420px] items-center justify-center p-6 text-center text-sm font-semibold text-slate-600 lg:h-[520px]">
                  Mapbox token required.
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2 rounded-md border border-slate-200 bg-white p-2 text-xs font-bold text-slate-700 shadow-sm">
              <LegendSwatch color="#991b1b" label="Pre-1950" />
              <LegendSwatch color="#dc2626" label="1950-1969" />
              <LegendSwatch color="#f97316" label="1970-1989" />
              <LegendSwatch color="#eab308" label="1990-2009" />
              <LegendSwatch color="#22c55e" label="2010+" />
              <span className="ml-auto text-slate-500">Blue outlines mark duplex rows.</span>
            </div>

            <Panel title="Address table">
              <div className="max-h-[480px] overflow-auto">
                <table className="w-full min-w-[1320px] border-collapse text-left text-xs">
                  <thead className="sticky top-0 z-10 bg-slate-50 uppercase tracking-normal text-slate-500">
                    <tr className="border-y border-slate-200">
                      <TableHeader>Address</TableHeader>
                      <TableHeader>Dwelling type</TableHeader>
                      <TableHeader>Year</TableHeader>
                      <TableHeader>Age band</TableHeader>
                      <TableHeader>Land use</TableHeader>
                      <TableHeader>Roof sqft</TableHeader>
                      <TableHeader>Squares</TableHeader>
                      <TableHeader>Confidence</TableHeader>
                      <TableHeader>Expected error</TableHeader>
                      <TableHeader>Flags</TableHeader>
                      <TableHeader>Status</TableHeader>
                      <TableHeader>View</TableHeader>
                    </tr>
                  </thead>
                  <tbody>
                    {batchResults.length === 0 ? (
                      <tr>
                        <td colSpan={12} className="px-3 py-7 text-center text-sm text-slate-500">
                          Select a community and load eligible Calgary addresses. No pasted address
                          list is needed.
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
                        <TableCell>
                          <span className="block max-w-[280px] truncate font-bold text-slate-950">
                            {result.address.address}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span
                            className={`rounded-md border px-2 py-1 text-[11px] font-bold ${
                              result.address.dwellingType === "Duplex"
                                ? "border-blue-200 bg-blue-50 text-blue-800"
                                : "border-slate-200 bg-white text-slate-700"
                            }`}
                          >
                            {result.address.dwellingType}
                          </span>
                        </TableCell>
                        <TableCell>{result.address.constructionYear ?? "Unknown"}</TableCell>
                        <TableCell>{result.address.ageBand}</TableCell>
                        <TableCell>{result.address.landUse || "Unknown"}</TableCell>
                        <TableCell>{result.roofSqft ? `${formatNumber(result.roofSqft)} sqft` : "-"}</TableCell>
                        <TableCell>{result.roofingSquares ? formatNumber(result.roofingSquares, 1) : "-"}</TableCell>
                        <TableCell>{result.confidence}</TableCell>
                        <TableCell>
                          {result.expectedErrorPercent
                            ? `+/- ${formatNumber(result.expectedErrorPercent)}%`
                            : "-"}
                        </TableCell>
                        <TableCell>
                          <span className="block max-w-[280px] truncate">
                            {result.flags.join("; ")}
                          </span>
                        </TableCell>
                        <TableCell>{result.status}</TableCell>
                        <TableCell>
                          <button
                            type="button"
                            onClick={() => setSelectedAddressId(result.id)}
                            className="secondary-button h-8 px-2 text-xs"
                          >
                            View
                          </button>
                        </TableCell>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>

          <aside className="grid min-w-0 content-start gap-3">
            <Panel title="Selected address">
              {selectedResult ? (
                <div className="grid gap-3">
                  <div>
                    <h2 className="text-base font-bold text-slate-950">
                      {selectedResult.address.address}
                    </h2>
                    <p className="text-xs font-semibold text-slate-600">
                      {selectedResult.address.community} / {selectedResult.address.dwellingType} /{" "}
                      {selectedResult.address.classificationSource}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <Readout
                      label="Roof sqft"
                      value={`${formatNumber(selectedResult.roofSqft)} sqft`}
                      strong
                    />
                    <Readout label="Roofing squares" value={formatNumber(selectedResult.roofingSquares, 1)} />
                    <Readout
                      label="Confidence"
                      value={`${selectedResult.confidence} +/- ${formatNumber(
                        selectedResult.expectedErrorPercent,
                      )}%`}
                    />
                    <Readout
                      label="Structures"
                      value={`${selectedResult.includedStructures} in / ${selectedResult.excludedStructures} out`}
                    />
                  </div>

                  <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs font-semibold text-slate-700">
                    <p>Source: City of Calgary Property Assessments API 4bsw-nn7w.</p>
                    <p>
                      Land use {selectedResult.address.landUse || "unknown"}, assessment{" "}
                      {selectedResult.address.assessmentClassDescription || "unknown"}, unique key{" "}
                      {selectedResult.address.uniqueKey || "not supplied"}.
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="field-label">
                      Pitch override
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
                      Overhang
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
                      Calibration
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
                      Confidence
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
                            {confidence}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-label">
                      Detached garage
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
                        <option value="exclude">Exclude</option>
                        <option value="include">Include</option>
                        <option value="auto">Auto</option>
                      </select>
                    </label>
                    <label className="field-label">
                      Attached garage
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
                        <option value="include">Include</option>
                        <option value="exclude">Exclude</option>
                      </select>
                    </label>
                  </div>

                  <label className="field-label">
                    Notes
                    <textarea
                      value={selectedOverride.notes ?? ""}
                      onChange={(event) =>
                        updateOverride(selectedResult.id, { notes: event.target.value })
                      }
                      rows={3}
                      className="control min-h-20 resize-y py-2"
                      placeholder="Saved automatically to this browser"
                    />
                  </label>

                  <div className="grid gap-2">
                    <h3 className="text-xs font-bold uppercase tracking-normal text-slate-500">
                      Included/excluded roof structures
                    </h3>
                    {selectedResult.facets.length === 0 ? (
                      <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs font-semibold text-amber-900">
                        No Mapbox building footprint has been attached to this row yet.
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
                              Structure {index + 1}: {facet.role}
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
                            {facet.included ? "Included" : "Excluded"}
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
                      Flags
                    </p>
                    <p className="text-xs font-semibold text-slate-700">
                      {selectedResult.flags.join("; ")}
                    </p>
                    <p className="mt-2 text-xs font-bold uppercase tracking-normal text-slate-500">
                      Assumptions
                    </p>
                    <p className="text-xs font-semibold text-slate-700">
                      {selectedResult.assumptions.join("; ")}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm font-medium text-slate-600">
                  Load a community and select an address row to inspect source data, assumptions,
                  structures, and overrides.
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

function TableHeader({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-bold">{children}</th>;
}

function TableCell({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 align-middle text-slate-700">{children}</td>;
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="h-3 w-3 rounded-sm border border-slate-300" style={{ background: color }} />
      {label}
    </span>
  );
}

function AgeBreakdownTable({ summary }: { summary: CommunitySummary }) {
  return (
    <div className="overflow-hidden rounded-md border border-slate-200">
      <table className="w-full border-collapse text-left text-xs">
        <thead className="bg-slate-50 uppercase tracking-normal text-slate-500">
          <tr>
            <TableHeader>Age band</TableHeader>
            <TableHeader>Detached</TableHeader>
            <TableHeader>Duplex</TableHeader>
          </tr>
        </thead>
        <tbody>
          {AGE_BANDS.map((band) => (
            <tr key={band} className="border-t border-slate-100">
              <TableCell>{band}</TableCell>
              <TableCell>{formatNumber(summary.ageTypeBreakdown[band]["Single detached"])}</TableCell>
              <TableCell>{formatNumber(summary.ageTypeBreakdown[band].Duplex)}</TableCell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
