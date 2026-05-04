"use client";

import {
  area as turfArea,
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

type PitchValue = "3/12" | "4/12" | "6/12" | "8/12" | "10/12" | "12/12";
type Confidence = "High" | "Medium" | "Low" | "Unusable";
type Status = "Pass" | "Review" | "Fail";
type GaragePolicy = "auto" | "include" | "exclude";
type StructureRole =
  | "Main roof"
  | "Attached roof candidate"
  | "Detached garage candidate"
  | "Small outbuilding"
  | "Nearby structure";

type Facet = {
  id: string;
  feature: RoofFeature;
  pitch: PitchValue;
  included: boolean;
  source: "address" | "nearby" | "saved";
  role: StructureRole;
  includeReason: string;
};

type CalculatedFacet = Facet & {
  buildingFootprintSqft: number;
  footprintSqft: number;
  pitchMultiplier: number;
  roofSurfaceSqft: number;
  distanceFromAddressMeters: number | null;
};

type SavedMeasurement = {
  id: string;
  address: string;
  latitude: number;
  longitude: number;
  facets: Array<{
    id: string;
    feature: RoofFeature;
    pitch: PitchValue;
    included: boolean;
    source: "address" | "nearby" | "saved";
    role: StructureRole;
    includeReason: string;
    buildingFootprintSqft: number;
    footprintSqft: number;
    roofSurfaceSqft: number;
  }>;
  totalFootprintSqft: number;
  totalRoofSurfaceSqft: number;
  wasteFactor: number;
  overhangInches: number;
  calibrationAdjustmentPercent: number;
  wasteAdjustedSqft: number;
  roofingSquares: number;
  existingToolSqft: number | null;
  existingToolIncludesWaste: boolean;
  differenceSqft: number | null;
  differencePercent: number | null;
  status: Status | null;
  confidence: Confidence;
  notes: string;
  createdAt: string;
};

type AutoEstimateResult =
  | {
      ok: true;
      facets: Facet[];
      source: string;
    }
  | { ok: false; reason: string };

type AutoRoofProfile = {
  label: string;
  pitch: PitchValue;
  overhangInches: number;
  calibrationAdjustmentPercent: number;
  confidence: Confidence;
  expectedErrorPercent: number;
  reasons: string[];
};

type CommunityProfile = {
  community: string;
  buildEra: string;
  dominantHouseType: string;
  defaultPitch: PitchValue;
  defaultOverhangInches: number;
  detachedGaragePolicy: GaragePolicy;
  attachedGaragePolicy: "include" | "exclude";
  calibrationAdjustmentPercent: number;
  expectedErrorPercent: number;
  confidence: Confidence;
  notes: string;
};

type BatchResult = {
  id: string;
  address: string;
  resolvedAddress: string;
  community: string;
  latitude: number | null;
  longitude: number | null;
  buildingFootprintSqft: number;
  overhangFootprintSqft: number;
  roofSqft: number;
  roofingSquares: number;
  wasteAdjustedSqft: number;
  pitch: PitchValue;
  pitchMultiplier: number;
  overhangInches: number;
  calibrationAdjustmentPercent: number;
  buildEra: string;
  houseType: string;
  garagePolicy: string;
  includedStructures: number;
  excludedStructures: number;
  confidence: Confidence;
  expectedErrorPercent: number;
  flags: string[];
  assumptions: string[];
  facets: Facet[];
  status: "Estimated" | "No footprint" | "Error";
};

const SQM_TO_SQFT = 10.7639;
const DEFAULT_PITCH: PitchValue = "6/12";
const STORAGE_KEY = "roof-sqft-calibration-measurements-v1";
const BUILDING_SOURCE_ID = "auto-building-source";
const BUILDING_FOOTPRINT_LAYER_ID = "auto-building-footprints";

const PITCH_OPTIONS: Array<{ label: PitchValue; multiplier: number }> = [
  { label: "3/12", multiplier: 1.031 },
  { label: "4/12", multiplier: 1.054 },
  { label: "6/12", multiplier: 1.118 },
  { label: "8/12", multiplier: 1.202 },
  { label: "10/12", multiplier: 1.302 },
  { label: "12/12", multiplier: 1.414 },
];

const CONFIDENCE_HELP: Record<Confidence, string> = {
  High: "Clear image, simple roof, known pitch",
  Medium: "Clear image, assumed pitch or moderate complexity",
  Low: "Trees, shadows, complex roof, or uncertain pitch",
  Unusable: "Roof cannot be measured reliably",
};

const COMMUNITY_PROFILES: CommunityProfile[] = [
  {
    community: "Sandstone Valley",
    buildEra: "1980s-1990s",
    dominantHouseType: "two-storey detached",
    defaultPitch: "8/12",
    defaultOverhangInches: 12,
    detachedGaragePolicy: "exclude",
    attachedGaragePolicy: "include",
    calibrationAdjustmentPercent: 8,
    expectedErrorPercent: 14,
    confidence: "Medium",
    notes: "Suburban north Calgary profile with many attached garages and moderately steep rooflines.",
  },
  {
    community: "Acadia",
    buildEra: "1950s-1960s",
    dominantHouseType: "bungalow",
    defaultPitch: "4/12",
    defaultOverhangInches: 14,
    detachedGaragePolicy: "exclude",
    attachedGaragePolicy: "include",
    calibrationAdjustmentPercent: 4,
    expectedErrorPercent: 16,
    confidence: "Medium",
    notes: "Older bungalow profile. Detached rear garages are common and excluded by default.",
  },
  {
    community: "Bowness",
    buildEra: "mixed older and infill",
    dominantHouseType: "bungalow and infill mix",
    defaultPitch: "6/12",
    defaultOverhangInches: 14,
    detachedGaragePolicy: "exclude",
    attachedGaragePolicy: "include",
    calibrationAdjustmentPercent: 6,
    expectedErrorPercent: 20,
    confidence: "Low",
    notes: "Mixed housing stock and mature trees increase variance.",
  },
  {
    community: "Mahogany",
    buildEra: "2010s-2020s",
    dominantHouseType: "newer two-storey detached",
    defaultPitch: "8/12",
    defaultOverhangInches: 12,
    detachedGaragePolicy: "exclude",
    attachedGaragePolicy: "include",
    calibrationAdjustmentPercent: 10,
    expectedErrorPercent: 15,
    confidence: "Medium",
    notes: "Newer suburban profile with attached garages and more complex rooflines.",
  },
  {
    community: "Default Calgary",
    buildEra: "unknown",
    dominantHouseType: "detached residential",
    defaultPitch: "6/12",
    defaultOverhangInches: 12,
    detachedGaragePolicy: "exclude",
    attachedGaragePolicy: "include",
    calibrationAdjustmentPercent: 5,
    expectedErrorPercent: 18,
    confidence: "Medium",
    notes: "Fallback profile when the community has not been researched yet.",
  },
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

function parseOptionalPositive(value: string) {
  if (!value.trim()) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.NaN;
}

function statusForDifference(differencePercent: number): Status {
  const absoluteDifference = Math.abs(differencePercent);

  if (absoluteDifference <= 10) {
    return "Pass";
  }

  if (absoluteDifference <= 15) {
    return "Review";
  }

  return "Fail";
}

function getStatusClasses(status: Status | null) {
  if (status === "Pass") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (status === "Review") {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }

  if (status === "Fail") {
    return "border-red-200 bg-red-50 text-red-700";
  }

  return "border-slate-200 bg-slate-50 text-slate-600";
}

function csvEscape(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }

  const raw = String(value);
  return /[",\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
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

function countVertices(feature: RoofFeature) {
  if (feature.geometry.type === "Polygon") {
    return feature.geometry.coordinates.flat().length;
  }

  return feature.geometry.coordinates.flat(2).length;
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
        ? "Closest footprint contains the geocoded address point."
        : "Closest footprint to the geocoded address point.",
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
      includeReason: "Garage-scale footprint excluded unless the roof report includes detached garages.",
    };
  }

  return {
    role: "Nearby structure",
    included: false,
    includeReason: "Nearby footprint excluded to avoid counting the wrong structure.",
  };
}

function deriveRoofProfile(facets: Facet[]): AutoRoofProfile | null {
  const includedFacets = facets.filter((facet) => facet.included);

  if (includedFacets.length === 0) {
    return null;
  }

  const includedFootprintSqft = includedFacets.reduce(
    (sum, facet) => sum + turfArea(facet.feature) * SQM_TO_SQFT,
    0,
  );
  const vertexCount = includedFacets.reduce((sum, facet) => sum + countVertices(facet.feature), 0);
  const nearbyCount = facets.length - includedFacets.length;
  const roleSummary = includedFacets.map((facet) => facet.role).join(", ");
  const reasons = [
    `${includedFacets.length} included structure${includedFacets.length === 1 ? "" : "s"}: ${roleSummary}.`,
  ];

  if (nearbyCount > 0) {
    reasons.push(`${nearbyCount} nearby footprint${nearbyCount === 1 ? "" : "s"} excluded by default.`);
  }

  if (includedFootprintSqft < 900) {
    reasons.push("Small footprint profile uses a lower pitch assumption and wider error band.");
    return {
      label: "Small low-complexity roof",
      pitch: "4/12",
      overhangInches: 10,
      calibrationAdjustmentPercent: 2,
      confidence: "Low",
      expectedErrorPercent: nearbyCount > 0 ? 22 : 18,
      reasons,
    };
  }

  if (includedFootprintSqft > 3200 || vertexCount > 18 || includedFacets.length > 1) {
    reasons.push("Large or irregular footprint profile uses steeper pitch and positive calibration.");
    return {
      label: "Large or complex roof",
      pitch: "8/12",
      overhangInches: 12,
      calibrationAdjustmentPercent: 8,
      confidence: nearbyCount > 2 ? "Low" : "Medium",
      expectedErrorPercent: nearbyCount > 2 ? 24 : 18,
      reasons,
    };
  }

  reasons.push("Standard detached-home profile uses 6/12 pitch and modest calibration.");

  return {
    label: "Standard detached home",
    pitch: "6/12",
    overhangInches: 12,
    calibrationAdjustmentPercent: 4,
    confidence: nearbyCount > 2 ? "Medium" : "High",
    expectedErrorPercent: nearbyCount > 2 ? 16 : 12,
    reasons,
  };
}

function applyCommunityProfile(facets: Facet[], profile: CommunityProfile) {
  return facets.map((facet) => {
    const isDetachedGarage = facet.role === "Detached garage candidate";
    const isAttachedCandidate = facet.role === "Attached roof candidate";
    const shouldInclude =
      facet.role === "Main roof" ||
      (isAttachedCandidate && profile.attachedGaragePolicy === "include") ||
      (isDetachedGarage && profile.detachedGaragePolicy === "include") ||
      (!isDetachedGarage && !isAttachedCandidate && facet.included);

    return {
      ...facet,
      pitch: shouldInclude ? profile.defaultPitch : facet.pitch,
      included: shouldInclude,
      includeReason: isDetachedGarage
        ? `Community garage policy is ${profile.detachedGaragePolicy}. Detached garage candidate ${
            shouldInclude ? "included" : "excluded"
          }.`
        : isAttachedCandidate
          ? `Community attached garage policy is ${profile.attachedGaragePolicy}. Attached roof candidate ${
              shouldInclude ? "included" : "excluded"
            }.`
          : facet.includeReason,
    };
  });
}

function summarizeFacets({
  facets,
  overhangInches,
  calibrationAdjustmentPercent,
  wasteFactor,
}: {
  facets: Facet[];
  overhangInches: number;
  calibrationAdjustmentPercent: number;
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
  const baseRoofSqft = includedFacets.reduce((sum, facet) => {
    const footprintSqft = turfArea(applyOverhang(facet.feature, overhangInches)) * SQM_TO_SQFT;

    return sum + footprintSqft * pitchMultiplierFor(facet.pitch);
  }, 0);
  const roofSqft = baseRoofSqft * (1 + calibrationAdjustmentPercent / 100);
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

function flagsForEstimate(facets: Facet[], profile: CommunityProfile, expectedErrorPercent: number) {
  const flags: string[] = [];

  if (facets.length > 1) {
    flags.push("multiple structures found");
  }

  if (facets.some((facet) => facet.role === "Detached garage candidate" && !facet.included)) {
    flags.push("detached garage excluded");
  }

  if (profile.defaultPitch !== DEFAULT_PITCH) {
    flags.push("community pitch override applied");
  }

  if (expectedErrorPercent >= 18) {
    flags.push("wide error range");
  }

  if (facets.some((facet) => facet.role === "Nearby structure")) {
    flags.push("nearby structure excluded");
  }

  return flags.length > 0 ? flags : ["standard community assumptions"];
}

function recalculateBatchResult(
  result: BatchResult,
  facets: Facet[],
  overrides: Partial<Pick<BatchResult, "overhangInches" | "calibrationAdjustmentPercent">> = {},
): BatchResult {
  const profile =
    COMMUNITY_PROFILES.find((item) => item.community === result.community) ??
    COMMUNITY_PROFILES[COMMUNITY_PROFILES.length - 1];
  const overhangInches = overrides.overhangInches ?? result.overhangInches;
  const calibrationAdjustmentPercent =
    overrides.calibrationAdjustmentPercent ?? result.calibrationAdjustmentPercent;
  const summary = summarizeFacets({
    facets,
    overhangInches,
    calibrationAdjustmentPercent,
    wasteFactor: 0,
  });
  const expectedErrorPercent =
    profile.expectedErrorPercent +
    (summary.excludedStructures > 2 ? 4 : 0) +
    (summary.includedStructures === 0 ? 50 : 0);

  return {
    ...result,
    facets,
    buildingFootprintSqft: summary.buildingFootprintSqft,
    overhangFootprintSqft: summary.overhangFootprintSqft,
    roofSqft: summary.roofSqft,
    roofingSquares: summary.roofingSquares,
    wasteAdjustedSqft: summary.wasteAdjustedSqft,
    overhangInches,
    calibrationAdjustmentPercent,
    includedStructures: summary.includedStructures,
    excludedStructures: summary.excludedStructures,
    pitch: facets.find((facet) => facet.included)?.pitch ?? result.pitch,
    pitchMultiplier: pitchMultiplierFor(facets.find((facet) => facet.included)?.pitch ?? result.pitch),
    confidence: expectedErrorPercent > 20 ? "Low" : profile.confidence,
    expectedErrorPercent,
    flags: flagsForEstimate(facets, profile, expectedErrorPercent),
    assumptions: [
      profile.notes,
      `Overrides now use ${facets.find((facet) => facet.included)?.pitch ?? result.pitch} pitch, ${overhangInches} inch overhang, ${calibrationAdjustmentPercent} percent calibration.`,
      ...facets.map((facet) => `${facet.role}: ${facet.includeReason}`),
    ],
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

function isRoofGeometry(
  geometry: Geometry | null | undefined,
): geometry is Polygon | MultiPolygon {
  return geometry?.type === "Polygon" || geometry?.type === "MultiPolygon";
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

  const bestCandidate = candidates[0];

  if (!bestCandidate) {
    return {
      ok: false,
      reason:
        "No nearby building footprint was found. This address cannot be estimated automatically from the available map data.",
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
      pitch: DEFAULT_PITCH,
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
        ? "Auto footprint from building polygon at the address point."
        : `Found ${facets.length} nearby building footprints. Closest structure is included by default.`,
  };
}

export default function RoofCalibrationTool() {
  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);
  const hasLoadedSavedMeasurementsRef = useRef(false);

  const [address, setAddress] = useState("");
  const [resolvedAddress, setResolvedAddress] = useState("");
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);
  const [facets, setFacets] = useState<Facet[]>([]);
  const [existingToolSqft, setExistingToolSqft] = useState("");
  const [existingToolIncludesWaste, setExistingToolIncludesWaste] = useState(false);
  const [wasteFactor, setWasteFactor] = useState("0");
  const [overhangInches, setOverhangInches] = useState("12");
  const [calibrationAdjustmentPercent, setCalibrationAdjustmentPercent] = useState("0");
  const [confidence, setConfidence] = useState<Confidence>("Medium");
  const [notes, setNotes] = useState("");
  const [savedMeasurements, setSavedMeasurements] = useState<SavedMeasurement[]>([]);
  const [searchError, setSearchError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [autoEstimateMessage, setAutoEstimateMessage] = useState("");
  const [autoRoofProfile, setAutoRoofProfile] = useState<AutoRoofProfile | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedCommunity, setSelectedCommunity] = useState("Sandstone Valley");
  const [batchAddresses, setBatchAddresses] = useState("");
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [selectedBatchResultId, setSelectedBatchResultId] = useState<string | null>(null);
  const [batchMessage, setBatchMessage] = useState("");
  const [isBatchRunning, setIsBatchRunning] = useState(false);

  const syncFacetsFromDraw = useCallback(() => {
    const draw = drawRef.current;

    if (!draw) {
      return;
    }

    const collection = draw.getAll() as FeatureCollection<Polygon | MultiPolygon>;

    setFacets((currentFacets) => {
      const currentFacetById = new Map(currentFacets.map((facet) => [facet.id, facet]));

      return collection.features.map((feature, index) => {
        const id = String(feature.id ?? `facet-${index + 1}`);
        const currentFacet = currentFacetById.get(id);

        return {
          id,
          feature: { ...feature, id } as RoofFeature,
          pitch: currentFacet?.pitch ?? DEFAULT_PITCH,
          included: currentFacet?.included ?? true,
          source: currentFacet?.source ?? "nearby",
          role: currentFacet?.role ?? "Nearby structure",
          includeReason: currentFacet?.includeReason ?? "Map feature restored from drawing state.",
        };
      });
    });
  }, []);

  useEffect(() => {
    const loadTimer = window.setTimeout(() => {
      const stored = window.localStorage.getItem(STORAGE_KEY);

      if (!stored) {
        hasLoadedSavedMeasurementsRef.current = true;
        return;
      }

      try {
        const parsed = JSON.parse(stored) as SavedMeasurement[];
        setSavedMeasurements(Array.isArray(parsed) ? parsed : []);
      } catch {
        setSavedMeasurements([]);
      } finally {
        hasLoadedSavedMeasurementsRef.current = true;
      }
    }, 0);

    return () => window.clearTimeout(loadTimer);
  }, []);

  useEffect(() => {
    if (!hasLoadedSavedMeasurementsRef.current) {
      return;
    }

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(savedMeasurements));
  }, [savedMeasurements]);

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
      controls: {},
    });

    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-right");
    map.addControl(draw, "top-left");

    map.on("load", () => {
      if (!map.getSource(BUILDING_SOURCE_ID)) {
        map.addSource(BUILDING_SOURCE_ID, {
          type: "vector",
          url: "mapbox://mapbox.mapbox-streets-v8",
        });
      }

      if (!map.getLayer(BUILDING_FOOTPRINT_LAYER_ID)) {
        map.addLayer({
          id: BUILDING_FOOTPRINT_LAYER_ID,
          type: "fill",
          source: BUILDING_SOURCE_ID,
          "source-layer": "building",
          minzoom: 13,
          paint: {
            "fill-color": "#38bdf8",
            "fill-opacity": 0.18,
            "fill-outline-color": "#0f172a",
          },
        });
      }
    });

    map.on("draw.create", syncFacetsFromDraw);
    map.on("draw.update", syncFacetsFromDraw);
    map.on("draw.delete", syncFacetsFromDraw);

    mapRef.current = map;
    drawRef.current = draw;

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      drawRef.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, [mapboxToken, syncFacetsFromDraw]);

  const calculatedFacets = useMemo<CalculatedFacet[]>(() => {
    const parsedOverhang = Number(overhangInches);
    const validOverhang =
      Number.isFinite(parsedOverhang) && parsedOverhang >= 0 && parsedOverhang <= 36
        ? parsedOverhang
        : 0;

    return facets.map((facet) => {
      const buildingFootprintSqft = turfArea(facet.feature) * SQM_TO_SQFT;
      const overhangFeature = applyOverhang(facet.feature, validOverhang);
      const footprintSqft = turfArea(overhangFeature) * SQM_TO_SQFT;
      const pitchMultiplier = pitchMultiplierFor(facet.pitch);
      const distanceFromAddressMeters =
        typeof facet.feature.properties?.distanceFromAddressMeters === "number"
          ? facet.feature.properties.distanceFromAddressMeters
          : null;

      return {
        ...facet,
        buildingFootprintSqft,
        footprintSqft,
        pitchMultiplier,
        roofSurfaceSqft: footprintSqft * pitchMultiplier,
        distanceFromAddressMeters,
      };
    });
  }, [facets, overhangInches]);

  const totals = useMemo(() => {
    const includedFacets = calculatedFacets.filter((facet) => facet.included);
    const totalBuildingFootprintSqft = includedFacets.reduce(
      (sum, facet) => sum + facet.buildingFootprintSqft,
      0,
    );
    const totalFootprintSqft = includedFacets.reduce(
      (sum, facet) => sum + facet.footprintSqft,
      0,
    );
    const baseRoofSurfaceSqft = includedFacets.reduce(
      (sum, facet) => sum + facet.roofSurfaceSqft,
      0,
    );
    const parsedWaste = Number(wasteFactor);
    const validWasteFactor =
      Number.isFinite(parsedWaste) && parsedWaste >= 0 && parsedWaste <= 30
        ? parsedWaste
        : 0;
    const parsedCalibrationAdjustment = Number(calibrationAdjustmentPercent);
    const validCalibrationAdjustmentPercent =
      Number.isFinite(parsedCalibrationAdjustment) &&
      parsedCalibrationAdjustment >= -30 &&
      parsedCalibrationAdjustment <= 30
        ? parsedCalibrationAdjustment
        : 0;
    const totalRoofSurfaceSqft =
      baseRoofSurfaceSqft * (1 + validCalibrationAdjustmentPercent / 100);
    const wasteAdjustedSqft = totalRoofSurfaceSqft * (1 + validWasteFactor / 100);

    return {
      totalBuildingFootprintSqft,
      totalFootprintSqft,
      baseRoofSurfaceSqft,
      totalRoofSurfaceSqft,
      roofingSquares: totalRoofSurfaceSqft / 100,
      validWasteFactor,
      validCalibrationAdjustmentPercent,
      wasteAdjustedSqft,
      wasteAdjustedRoofingSquares: wasteAdjustedSqft / 100,
    };
  }, [calculatedFacets, calibrationAdjustmentPercent, wasteFactor]);

  const comparison = useMemo(() => {
    const existing = parseOptionalPositive(existingToolSqft);

    if (existing === null || Number.isNaN(existing)) {
      return null;
    }

    const differenceSqft = totals.totalRoofSurfaceSqft - existing;
    const differencePercent = (differenceSqft / existing) * 100;

    return {
      existing,
      differenceSqft,
      differencePercent,
      status: statusForDifference(differencePercent),
    };
  }, [existingToolSqft, totals.totalRoofSurfaceSqft]);

  const handleAddressSearch = async () => {
    setSearchError("");
    setSaveMessage("");
    setAutoEstimateMessage("");
    setAutoRoofProfile(null);

    if (!address.trim()) {
      setSearchError("Address is required before map search.");
      return;
    }

    if (!mapboxToken) {
      setSearchError("NEXT_PUBLIC_MAPBOX_TOKEN is missing. Add it to .env.local and restart.");
      return;
    }

    setIsSearching(true);

    try {
      const response = await fetch(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(
          address.trim(),
        )}.json?access_token=${mapboxToken}&limit=1&types=address`,
      );

      if (!response.ok) {
        throw new Error("Mapbox geocoding failed.");
      }

      const data = (await response.json()) as {
        features?: Array<{ center: [number, number]; place_name?: string }>;
      };
      const result = data.features?.[0];

      if (!result) {
        setSearchError("No address match found. Check the address and search again.");
        return;
      }

      const [lng, lat] = result.center;
      setLongitude(lng);
      setLatitude(lat);
      setResolvedAddress(result.place_name ?? address.trim());

      const map = mapRef.current;

      if (map) {
        map.flyTo({ center: [lng, lat], zoom: 19.5, essential: true });
        markerRef.current?.remove();
        markerRef.current = new mapboxgl.Marker({ color: "#2563eb" })
          .setLngLat([lng, lat])
          .addTo(map);
        await waitForMapIdle(map);

        const autoEstimate = findBuildingFootprints(map, [lng, lat]);

        if (autoEstimate.ok) {
          const profile = deriveRoofProfile(autoEstimate.facets);
          const profiledFacets = profile
            ? autoEstimate.facets.map((facet) => ({
                ...facet,
                pitch: facet.included ? profile.pitch : facet.pitch,
              }))
            : autoEstimate.facets;

          drawRef.current?.deleteAll();
          profiledFacets.forEach((facet) => drawRef.current?.add(facet.feature));
          setFacets(profiledFacets);
          if (profile) {
            setOverhangInches(String(profile.overhangInches));
            setCalibrationAdjustmentPercent(String(profile.calibrationAdjustmentPercent));
            setConfidence(profile.confidence);
            setAutoRoofProfile(profile);
          } else {
            setConfidence("Medium");
          }
          setAutoEstimateMessage(autoEstimate.source);
        } else {
          drawRef.current?.deleteAll();
          setFacets([]);
          setConfidence("Unusable");
          setAutoRoofProfile(null);
          setAutoEstimateMessage(autoEstimate.reason);
        }
      }
    } catch {
      setSearchError("Search failed. Confirm the Mapbox token and try again.");
    } finally {
      setIsSearching(false);
    }
  };

  const runBatchEstimate = async () => {
    const profile =
      COMMUNITY_PROFILES.find((item) => item.community === selectedCommunity) ??
      COMMUNITY_PROFILES[COMMUNITY_PROFILES.length - 1];
    const addresses = batchAddresses
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 250);
    const map = mapRef.current;

    setBatchMessage("");
    setBatchResults([]);
    setSelectedBatchResultId(null);

    if (addresses.length === 0) {
      setBatchMessage("Paste at least one address, one per line.");
      return;
    }

    if (!mapboxToken || !map) {
      setBatchMessage("Mapbox must be loaded before batch estimates can run.");
      return;
    }

    setIsBatchRunning(true);

    const results: BatchResult[] = [];

    for (const [index, batchAddress] of addresses.entries()) {
      setBatchMessage(`Estimating ${index + 1} of ${addresses.length}`);

      try {
        const response = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(
            batchAddress,
          )}.json?access_token=${mapboxToken}&limit=1&types=address&proximity=-114.0719,51.0447`,
        );

        if (!response.ok) {
          throw new Error("Mapbox geocoding failed.");
        }

        const data = (await response.json()) as {
          features?: Array<{ center: [number, number]; place_name?: string }>;
        };
        const result = data.features?.[0];

        if (!result) {
          results.push({
            id: crypto.randomUUID(),
            address: batchAddress,
            resolvedAddress: "",
            community: profile.community,
            latitude: null,
            longitude: null,
            buildingFootprintSqft: 0,
            overhangFootprintSqft: 0,
            roofSqft: 0,
            roofingSquares: 0,
            wasteAdjustedSqft: 0,
            pitch: profile.defaultPitch,
            pitchMultiplier: pitchMultiplierFor(profile.defaultPitch),
            overhangInches: profile.defaultOverhangInches,
            calibrationAdjustmentPercent: profile.calibrationAdjustmentPercent,
            buildEra: profile.buildEra,
            houseType: profile.dominantHouseType,
            garagePolicy: `detached ${profile.detachedGaragePolicy}, attached ${profile.attachedGaragePolicy}`,
            includedStructures: 0,
            excludedStructures: 0,
            confidence: "Unusable",
            expectedErrorPercent: 100,
            flags: ["geocode failed"],
            assumptions: [profile.notes],
            facets: [],
            status: "Error",
          });
          setBatchResults([...results]);
          continue;
        }

        const [lng, lat] = result.center;
        map.flyTo({ center: [lng, lat], zoom: 19.5, essential: true });
        await waitForMapIdle(map);

        const estimate = findBuildingFootprints(map, [lng, lat]);

        if (!estimate.ok) {
          results.push({
            id: crypto.randomUUID(),
            address: batchAddress,
            resolvedAddress: result.place_name ?? batchAddress,
            community: profile.community,
            latitude: lat,
            longitude: lng,
            buildingFootprintSqft: 0,
            overhangFootprintSqft: 0,
            roofSqft: 0,
            roofingSquares: 0,
            wasteAdjustedSqft: 0,
            pitch: profile.defaultPitch,
            pitchMultiplier: pitchMultiplierFor(profile.defaultPitch),
            overhangInches: profile.defaultOverhangInches,
            calibrationAdjustmentPercent: profile.calibrationAdjustmentPercent,
            buildEra: profile.buildEra,
            houseType: profile.dominantHouseType,
            garagePolicy: `detached ${profile.detachedGaragePolicy}, attached ${profile.attachedGaragePolicy}`,
            includedStructures: 0,
            excludedStructures: 0,
            confidence: "Unusable",
            expectedErrorPercent: 100,
            flags: ["no building footprint"],
            assumptions: [estimate.reason, profile.notes],
            facets: [],
            status: "No footprint",
          });
          setBatchResults([...results]);
          continue;
        }

        const profiledFacets = applyCommunityProfile(estimate.facets, profile);
        const summary = summarizeFacets({
          facets: profiledFacets,
          overhangInches: profile.defaultOverhangInches,
          calibrationAdjustmentPercent: profile.calibrationAdjustmentPercent,
          wasteFactor: Number(wasteFactor) || 0,
        });
        const expectedErrorPercent =
          profile.expectedErrorPercent +
          (summary.excludedStructures > 2 ? 4 : 0) +
          (summary.includedStructures === 0 ? 50 : 0);
        const flags = flagsForEstimate(profiledFacets, profile, expectedErrorPercent);

        results.push({
          id: crypto.randomUUID(),
          address: batchAddress,
          resolvedAddress: result.place_name ?? batchAddress,
          community: profile.community,
          latitude: lat,
          longitude: lng,
          buildingFootprintSqft: summary.buildingFootprintSqft,
          overhangFootprintSqft: summary.overhangFootprintSqft,
          roofSqft: summary.roofSqft,
          roofingSquares: summary.roofingSquares,
          wasteAdjustedSqft: summary.wasteAdjustedSqft,
          pitch: profile.defaultPitch,
          pitchMultiplier: pitchMultiplierFor(profile.defaultPitch),
          overhangInches: profile.defaultOverhangInches,
          calibrationAdjustmentPercent: profile.calibrationAdjustmentPercent,
          buildEra: profile.buildEra,
          houseType: profile.dominantHouseType,
          garagePolicy: `detached ${profile.detachedGaragePolicy}, attached ${profile.attachedGaragePolicy}`,
          includedStructures: summary.includedStructures,
          excludedStructures: summary.excludedStructures,
          confidence: expectedErrorPercent > 20 ? "Low" : profile.confidence,
          expectedErrorPercent,
          flags,
          assumptions: [
            profile.notes,
            `Community profile used ${profile.defaultPitch} pitch, ${profile.defaultOverhangInches} inch overhang, ${profile.calibrationAdjustmentPercent} percent calibration.`,
            ...profiledFacets.map((facet) => `${facet.role}: ${facet.includeReason}`),
          ],
          facets: profiledFacets,
          status: "Estimated",
        });
        setBatchResults([...results]);
      } catch {
        results.push({
          id: crypto.randomUUID(),
          address: batchAddress,
          resolvedAddress: "",
          community: profile.community,
          latitude: null,
          longitude: null,
          buildingFootprintSqft: 0,
          overhangFootprintSqft: 0,
          roofSqft: 0,
          roofingSquares: 0,
          wasteAdjustedSqft: 0,
          pitch: profile.defaultPitch,
          pitchMultiplier: pitchMultiplierFor(profile.defaultPitch),
          overhangInches: profile.defaultOverhangInches,
          calibrationAdjustmentPercent: profile.calibrationAdjustmentPercent,
          buildEra: profile.buildEra,
          houseType: profile.dominantHouseType,
          garagePolicy: `detached ${profile.detachedGaragePolicy}, attached ${profile.attachedGaragePolicy}`,
          includedStructures: 0,
          excludedStructures: 0,
          confidence: "Unusable",
          expectedErrorPercent: 100,
          flags: ["estimate failed"],
          assumptions: [profile.notes],
          facets: [],
          status: "Error",
        });
        setBatchResults([...results]);
      }
    }

    setBatchMessage(`Finished ${results.length} estimate${results.length === 1 ? "" : "s"}.`);
    setIsBatchRunning(false);
  };

  const updateFacetPitch = (id: string, pitch: PitchValue) => {
    setFacets((currentFacets) =>
      currentFacets.map((facet) => (facet.id === id ? { ...facet, pitch } : facet)),
    );
    setSaveMessage("");
  };

  const updateFacetIncluded = (id: string, included: boolean) => {
    setFacets((currentFacets) =>
      currentFacets.map((facet) => (facet.id === id ? { ...facet, included } : facet)),
    );
    setSaveMessage("");
  };

  const updateBatchResult = (id: string, updater: (result: BatchResult) => BatchResult) => {
    setBatchResults((currentResults) =>
      currentResults.map((result) => (result.id === id ? updater(result) : result)),
    );
  };

  const updateBatchAllIncludedPitch = (id: string, pitch: PitchValue) => {
    updateBatchResult(id, (result) =>
      recalculateBatchResult(
        result,
        result.facets.map((facet) => (facet.included ? { ...facet, pitch } : facet)),
      ),
    );
  };

  const updateBatchFacet = (id: string, facetId: string, patch: Partial<Facet>) => {
    updateBatchResult(id, (result) =>
      recalculateBatchResult(
        result,
        result.facets.map((facet) => (facet.id === facetId ? { ...facet, ...patch } : facet)),
      ),
    );
  };

  const updateBatchNumericOverride = (
    id: string,
    key: "overhangInches" | "calibrationAdjustmentPercent",
    value: string,
  ) => {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
      return;
    }

    updateBatchResult(id, (result) => recalculateBatchResult(result, result.facets, { [key]: numericValue }));
  };

  const deleteFacet = (id: string) => {
    drawRef.current?.delete(id);
    setFacets((currentFacets) => currentFacets.filter((facet) => facet.id !== id));
    setSaveMessage("");
  };

  const validateMeasurement = () => {
    if (!address.trim() && !resolvedAddress) {
      return "Address is required before saving.";
    }

    if (latitude === null || longitude === null) {
      return "Search and center the property before saving.";
    }

    if (calculatedFacets.length === 0 || !calculatedFacets.some((facet) => facet.included)) {
      return "At least one automatic roof footprint must be included before saving.";
    }

    const existing = parseOptionalPositive(existingToolSqft);

    if (Number.isNaN(existing)) {
      return "Existing tool sqft must be a positive number if entered.";
    }

    const waste = Number(wasteFactor);

    if (!Number.isFinite(waste) || waste < 0 || waste > 30) {
      return "Waste factor must be between 0 and 30 percent.";
    }

    const overhang = Number(overhangInches);

    if (!Number.isFinite(overhang) || overhang < 0 || overhang > 36) {
      return "Overhang must be between 0 and 36 inches.";
    }

    const calibration = Number(calibrationAdjustmentPercent);

    if (!Number.isFinite(calibration) || calibration < -30 || calibration > 30) {
      return "Calibration adjustment must be between -30 and 30 percent.";
    }

    return "";
  };

  const saveMeasurement = () => {
    const validationError = validateMeasurement();

    if (validationError) {
      setSaveMessage(validationError);
      return;
    }

    const existing = parseOptionalPositive(existingToolSqft);
    const savedComparison =
      existing !== null && !Number.isNaN(existing)
        ? {
            differenceSqft: totals.totalRoofSurfaceSqft - existing,
            differencePercent: ((totals.totalRoofSurfaceSqft - existing) / existing) * 100,
          }
        : null;

    const measurement: SavedMeasurement = {
      id: crypto.randomUUID(),
      address: resolvedAddress || address.trim(),
      latitude: latitude ?? 0,
      longitude: longitude ?? 0,
      facets: calculatedFacets.map((facet) => ({
        id: facet.id,
        feature: facet.feature,
        pitch: facet.pitch,
        included: facet.included,
        source: facet.source,
        role: facet.role,
        includeReason: facet.includeReason,
        buildingFootprintSqft: facet.buildingFootprintSqft,
        footprintSqft: facet.footprintSqft,
        roofSurfaceSqft: facet.roofSurfaceSqft,
      })),
      totalFootprintSqft: totals.totalFootprintSqft,
      totalRoofSurfaceSqft: totals.totalRoofSurfaceSqft,
      wasteFactor: Number(wasteFactor),
      overhangInches: Number(overhangInches),
      calibrationAdjustmentPercent: Number(calibrationAdjustmentPercent),
      wasteAdjustedSqft: totals.wasteAdjustedSqft,
      roofingSquares: totals.roofingSquares,
      existingToolSqft: existing,
      existingToolIncludesWaste,
      differenceSqft: savedComparison?.differenceSqft ?? null,
      differencePercent: savedComparison?.differencePercent ?? null,
      status: savedComparison
        ? statusForDifference(savedComparison.differencePercent)
        : null,
      confidence,
      notes,
      createdAt: new Date().toISOString(),
    };

    setSavedMeasurements((currentMeasurements) => [measurement, ...currentMeasurements]);
    setSaveMessage("Measurement saved.");
  };

  const viewMeasurement = (measurement: SavedMeasurement) => {
    setAddress(measurement.address);
    setResolvedAddress(measurement.address);
    setLatitude(measurement.latitude);
    setLongitude(measurement.longitude);
    setExistingToolSqft(measurement.existingToolSqft ? String(measurement.existingToolSqft) : "");
    setExistingToolIncludesWaste(measurement.existingToolIncludesWaste);
    setWasteFactor(String(measurement.wasteFactor));
    setOverhangInches(String(measurement.overhangInches ?? 12));
    setCalibrationAdjustmentPercent(String(measurement.calibrationAdjustmentPercent ?? 0));
    setConfidence(measurement.confidence);
    setNotes(measurement.notes);

    if (drawRef.current) {
      drawRef.current.deleteAll();
      measurement.facets.forEach((facet) => drawRef.current?.add(facet.feature));
    }

    setFacets(
      measurement.facets.map((facet) => ({
        id: facet.id,
        feature: facet.feature,
        pitch: facet.pitch,
        included: facet.included ?? true,
        source: facet.source ?? "saved",
        role: facet.role ?? "Nearby structure",
        includeReason: facet.includeReason ?? "Loaded from a saved measurement.",
      })),
    );
    setAutoRoofProfile(null);
    setSaveMessage("Loaded saved measurement.");

    if (mapRef.current) {
      mapRef.current.flyTo({
        center: [measurement.longitude, measurement.latitude],
        zoom: 19.5,
        essential: true,
      });
      markerRef.current?.remove();
      markerRef.current = new mapboxgl.Marker({ color: "#2563eb" })
        .setLngLat([measurement.longitude, measurement.latitude])
        .addTo(mapRef.current);
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const deleteMeasurement = (id: string) => {
    setSavedMeasurements((currentMeasurements) =>
      currentMeasurements.filter((measurement) => measurement.id !== id),
    );
  };

  const exportCsv = () => {
    const headers = [
      "Address",
      "Latitude",
      "Longitude",
      "Our sqft",
      "Existing tool sqft",
      "Difference percent",
      "Status",
      "Confidence",
      "Overhang inches",
      "Calibration adjustment percent",
      "Waste factor",
      "Waste adjusted sqft",
      "Roofing squares",
      "Created date",
      "Notes",
    ];
    const rows = savedMeasurements.map((measurement) => [
      measurement.address,
      measurement.latitude,
      measurement.longitude,
      Math.round(measurement.totalRoofSurfaceSqft),
      measurement.existingToolSqft ?? "",
      measurement.differencePercent === null
        ? ""
        : measurement.differencePercent.toFixed(1),
      measurement.status ?? "",
      measurement.confidence,
      measurement.overhangInches ?? 12,
      measurement.calibrationAdjustmentPercent ?? 0,
      measurement.wasteFactor,
      Math.round(measurement.wasteAdjustedSqft),
      measurement.roofingSquares.toFixed(1),
      new Date(measurement.createdAt).toLocaleString(),
      measurement.notes,
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => csvEscape(cell)).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "roof-sqft-calibration-measurements.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const exportBatchCsv = () => {
    const headers = [
      "Address",
      "Resolved address",
      "Community",
      "Latitude",
      "Longitude",
      "Building footprint sqft",
      "Overhang footprint sqft",
      "Roof sqft",
      "Roofing squares",
      "Waste adjusted sqft",
      "Pitch",
      "Pitch multiplier",
      "Overhang inches",
      "Calibration percent",
      "Build era",
      "House type",
      "Garage policy",
      "Included structures",
      "Excluded structures",
      "Confidence",
      "Expected error percent",
      "Flags",
      "Assumptions",
      "Status",
    ];
    const rows = batchResults.map((result) => [
      result.address,
      result.resolvedAddress,
      result.community,
      result.latitude ?? "",
      result.longitude ?? "",
      Math.round(result.buildingFootprintSqft),
      Math.round(result.overhangFootprintSqft),
      Math.round(result.roofSqft),
      result.roofingSquares.toFixed(1),
      Math.round(result.wasteAdjustedSqft),
      result.pitch,
      result.pitchMultiplier,
      result.overhangInches,
      result.calibrationAdjustmentPercent,
      result.buildEra,
      result.houseType,
      result.garagePolicy,
      result.includedStructures,
      result.excludedStructures,
      result.confidence,
      result.expectedErrorPercent,
      result.flags.join("; "),
      result.assumptions.join("; "),
      result.status,
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => csvEscape(cell)).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `${selectedCommunity.toLowerCase().replaceAll(" ", "-")}-roof-estimates.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const existingValue = parseOptionalPositive(existingToolSqft);
  const existingInputInvalid = Number.isNaN(existingValue);
  const wasteValue = Number(wasteFactor);
  const wasteInvalid = !Number.isFinite(wasteValue) || wasteValue < 0 || wasteValue > 30;
  const overhangValue = Number(overhangInches);
  const overhangInvalid =
    !Number.isFinite(overhangValue) || overhangValue < 0 || overhangValue > 36;
  const calibrationValue = Number(calibrationAdjustmentPercent);
  const calibrationInvalid =
    !Number.isFinite(calibrationValue) || calibrationValue < -30 || calibrationValue > 30;
  const currentCommunityProfile =
    COMMUNITY_PROFILES.find((profile) => profile.community === selectedCommunity) ??
    COMMUNITY_PROFILES[COMMUNITY_PROFILES.length - 1];
  const selectedBatchResult =
    batchResults.find((result) => result.id === selectedBatchResultId) ?? null;

  return (
    <main className="min-h-screen bg-[#f4f6f5] text-slate-900">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 px-4 py-4 lg:px-6">
        <header className="flex flex-col justify-between gap-3 border-b border-slate-200 pb-4 lg:flex-row lg:items-end">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal text-slate-950">
              Roof Sqft Calibration Tool
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Estimate a roof from map building data and compare it to an existing roof report.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-right">
            <Metric label="Footprint" value={`${formatNumber(totals.totalFootprintSqft)} sqft`} />
            <Metric label="Roof area" value={`${formatNumber(totals.totalRoofSurfaceSqft)} sqft`} />
            <Metric label="Squares" value={formatNumber(totals.roofingSquares, 1)} />
          </div>
        </header>

        {!mapboxToken ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
            NEXT_PUBLIC_MAPBOX_TOKEN is missing. Add it to .env.local and restart the dev server to enable automatic address estimates.
          </div>
        ) : null}

        <section className="grid gap-3 rounded-md border border-slate-200 bg-white p-3 shadow-sm xl:grid-cols-[1.4fr_0.8fr_0.7fr]">
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-normal text-slate-500">
            Address
            <div className="flex gap-2">
              <input
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleAddressSearch();
                  }
                }}
                placeholder="123 Example Street NW, Calgary, AB"
                className="min-h-10 flex-1 rounded-md border border-slate-300 px-3 text-sm font-normal normal-case text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
              <button
                onClick={() => void handleAddressSearch()}
                disabled={isSearching}
                className="min-h-10 rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {isSearching ? "Estimating" : "Estimate"}
              </button>
            </div>
            {searchError ? (
              <span className="text-xs font-medium normal-case text-red-700">{searchError}</span>
            ) : null}
            {resolvedAddress ? (
              <span className="text-xs font-medium normal-case text-slate-500">
                Estimated for {resolvedAddress}
              </span>
            ) : null}
            {autoEstimateMessage ? (
              <span
                className={`text-xs font-semibold normal-case ${
                  calculatedFacets.length > 0 ? "text-emerald-700" : "text-amber-800"
                }`}
              >
                {autoEstimateMessage}
              </span>
            ) : null}
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-normal text-slate-500">
              Existing tool sqft
              <input
                value={existingToolSqft}
                onChange={(event) => setExistingToolSqft(event.target.value)}
                inputMode="decimal"
                placeholder="Optional"
                className="min-h-10 rounded-md border border-slate-300 px-3 text-sm font-normal normal-case text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
              {existingInputInvalid ? (
                <span className="text-xs font-medium normal-case text-red-700">
                  Enter a positive number.
                </span>
              ) : null}
            </label>

            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-normal text-slate-500">
              Includes waste
              <button
                type="button"
                onClick={() => setExistingToolIncludesWaste((value) => !value)}
                className={`min-h-10 rounded-md border px-3 text-sm font-semibold normal-case ${
                  existingToolIncludesWaste
                    ? "border-blue-300 bg-blue-50 text-blue-800"
                    : "border-slate-300 bg-white text-slate-700"
                }`}
              >
                {existingToolIncludesWaste ? "Yes" : "No"}
              </button>
            </label>
          </div>

          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-normal text-slate-500">
            Notes
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              placeholder="Optional"
              className="min-h-10 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm font-normal normal-case text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
          </label>
        </section>

        <section className="grid gap-3 rounded-md border border-slate-200 bg-white p-3 shadow-sm xl:grid-cols-[360px_minmax(0,1fr)]">
          <div className="grid gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-950">
                Community Batch Estimator
              </h2>
              <p className="text-xs text-slate-500">
                Run one Calgary community at a time with shared pitch, garage, and calibration assumptions.
              </p>
            </div>

            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-normal text-slate-500">
              Community profile
              <select
                value={selectedCommunity}
                onChange={(event) => setSelectedCommunity(event.target.value)}
                className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold normal-case text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              >
                {COMMUNITY_PROFILES.map((profile) => (
                  <option key={profile.community} value={profile.community}>
                    {profile.community}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-2 gap-2">
              <Readout label="Build era" value={currentCommunityProfile.buildEra} />
              <Readout label="House type" value={currentCommunityProfile.dominantHouseType} />
              <Readout label="Pitch override" value={currentCommunityProfile.defaultPitch} />
              <Readout
                label="Expected error"
                value={`+/- ${formatNumber(currentCommunityProfile.expectedErrorPercent)} percent`}
              />
              <Readout
                label="Detached garage"
                value={currentCommunityProfile.detachedGaragePolicy}
              />
              <Readout
                label="Calibration"
                value={`${formatNumber(currentCommunityProfile.calibrationAdjustmentPercent)} percent`}
              />
            </div>
            <p className="rounded-md bg-slate-50 p-2 text-xs font-medium text-slate-600">
              {currentCommunityProfile.notes}
            </p>
          </div>

          <div className="grid gap-3">
            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-normal text-slate-500">
              Addresses
              <textarea
                value={batchAddresses}
                onChange={(event) => setBatchAddresses(event.target.value)}
                rows={7}
                placeholder={"One address per line\n123 Sandstone Dr NW, Calgary, AB\n124 Sandstone Dr NW, Calgary, AB"}
                className="resize-y rounded-md border border-slate-300 px-3 py-2 text-sm font-normal normal-case text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => void runBatchEstimate()}
                disabled={isBatchRunning}
                className="h-10 rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {isBatchRunning ? "Running Batch" : "Run Batch Estimate"}
              </button>
              <button
                onClick={exportBatchCsv}
                disabled={batchResults.length === 0}
                className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
              >
                Export Batch CSV
              </button>
              {batchMessage ? (
                <span className="text-xs font-semibold text-slate-600">{batchMessage}</span>
              ) : null}
            </div>

            {batchResults.length > 0 ? (
              <div className="max-h-[360px] overflow-auto rounded-md border border-slate-200">
                <table className="w-full min-w-[1180px] border-collapse text-left text-xs">
                  <thead className="sticky top-0 bg-slate-50 uppercase tracking-normal text-slate-500">
                    <tr className="border-b border-slate-200">
                      <TableHeader>Address</TableHeader>
                      <TableHeader>Roof sqft</TableHeader>
                      <TableHeader>Pitch</TableHeader>
                      <TableHeader>House type</TableHeader>
                      <TableHeader>Garage policy</TableHeader>
                      <TableHeader>Confidence</TableHeader>
                      <TableHeader>Error</TableHeader>
                      <TableHeader>Flags</TableHeader>
                      <TableHeader>Status</TableHeader>
                    </tr>
                  </thead>
                  <tbody>
                    {batchResults.map((result) => (
                      <tr
                        key={result.id}
                        onClick={() => setSelectedBatchResultId(result.id)}
                        className={`cursor-pointer border-b border-slate-100 ${
                          selectedBatchResultId === result.id
                            ? "bg-blue-50"
                            : "hover:bg-slate-50"
                        }`}
                      >
                        <TableCell>
                          <span className="block max-w-[300px] truncate font-semibold text-slate-900">
                            {result.address}
                          </span>
                        </TableCell>
                        <TableCell>{formatNumber(result.roofSqft)} sqft</TableCell>
                        <TableCell>{result.pitch}</TableCell>
                        <TableCell>{result.houseType}</TableCell>
                        <TableCell>{result.garagePolicy}</TableCell>
                        <TableCell>{result.confidence}</TableCell>
                        <TableCell>+/- {formatNumber(result.expectedErrorPercent)}%</TableCell>
                        <TableCell>
                          <span className="block max-w-[260px] truncate">
                            {result.flags.join("; ")}
                          </span>
                        </TableCell>
                        <TableCell>{result.status}</TableCell>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {selectedBatchResult ? (
              <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
                <div className="mb-3 flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
                  <div>
                    <h3 className="text-sm font-bold text-slate-950">
                      {selectedBatchResult.address}
                    </h3>
                    <p className="text-xs font-medium text-slate-600">
                      {selectedBatchResult.resolvedAddress || "No resolved address"}
                    </p>
                  </div>
                  <span className="w-fit rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-bold text-slate-700">
                    {selectedBatchResult.status}
                  </span>
                </div>

                <div className="grid gap-2 md:grid-cols-4">
                  <Readout
                    label="Roof sqft"
                    value={`${formatNumber(selectedBatchResult.roofSqft)} sqft`}
                    strong
                  />
                  <Readout
                    label="Squares"
                    value={formatNumber(selectedBatchResult.roofingSquares, 1)}
                  />
                  <Readout
                    label="Confidence"
                    value={`${selectedBatchResult.confidence}, +/- ${formatNumber(
                      selectedBatchResult.expectedErrorPercent,
                    )}%`}
                  />
                  <Readout
                    label="Structures"
                    value={`${selectedBatchResult.includedStructures} in, ${selectedBatchResult.excludedStructures} out`}
                  />
                </div>

                <div className="mt-3 grid gap-2 md:grid-cols-3">
                  <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-normal text-slate-500">
                    Pitch for included structures
                    <select
                      value={selectedBatchResult.pitch}
                      onChange={(event) =>
                        updateBatchAllIncludedPitch(
                          selectedBatchResult.id,
                          event.target.value as PitchValue,
                        )
                      }
                      className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm font-semibold normal-case text-slate-900"
                    >
                      {PITCH_OPTIONS.map((option) => (
                        <option key={option.label} value={option.label}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-normal text-slate-500">
                    Overhang inches
                    <input
                      value={selectedBatchResult.overhangInches}
                      onChange={(event) =>
                        updateBatchNumericOverride(
                          selectedBatchResult.id,
                          "overhangInches",
                          event.target.value,
                        )
                      }
                      inputMode="decimal"
                      className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm font-semibold normal-case text-slate-900"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-normal text-slate-500">
                    Calibration percent
                    <input
                      value={selectedBatchResult.calibrationAdjustmentPercent}
                      onChange={(event) =>
                        updateBatchNumericOverride(
                          selectedBatchResult.id,
                          "calibrationAdjustmentPercent",
                          event.target.value,
                        )
                      }
                      inputMode="decimal"
                      className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm font-semibold normal-case text-slate-900"
                    />
                  </label>
                </div>

                {selectedBatchResult.facets.length > 0 ? (
                  <div className="mt-3 grid gap-2">
                    {selectedBatchResult.facets.map((facet, index) => (
                      <div
                        key={facet.id}
                        className="grid gap-2 rounded-md border border-slate-200 bg-white p-2 md:grid-cols-[1fr_90px_110px]"
                      >
                        <div>
                          <p className="text-xs font-bold text-slate-900">
                            Structure {index + 1}: {facet.role}
                          </p>
                          <p className="text-[11px] font-medium text-slate-500">
                            {facet.includeReason}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            updateBatchFacet(selectedBatchResult.id, facet.id, {
                              included: !facet.included,
                              includeReason: facet.included
                                ? "Excluded by row-level override."
                                : "Included by row-level override.",
                            })
                          }
                          className={`h-9 rounded-md border px-2 text-xs font-bold ${
                            facet.included
                              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                              : "border-slate-200 bg-white text-slate-500"
                          }`}
                        >
                          {facet.included ? "Included" : "Excluded"}
                        </button>
                        <select
                          value={facet.pitch}
                          onChange={(event) =>
                            updateBatchFacet(selectedBatchResult.id, facet.id, {
                              pitch: event.target.value as PitchValue,
                            })
                          }
                          className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm font-semibold text-slate-900"
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
                ) : (
                  <p className="mt-3 rounded-md bg-white p-2 text-xs font-semibold text-amber-800">
                    No footprint geometry is available for this row.
                  </p>
                )}

                <div className="mt-3 rounded-md bg-white p-2">
                  <p className="text-xs font-bold uppercase tracking-normal text-slate-500">
                    Flags
                  </p>
                  <p className="text-xs font-medium text-slate-700">
                    {selectedBatchResult.flags.join("; ")}
                  </p>
                  <p className="mt-2 text-xs font-bold uppercase tracking-normal text-slate-500">
                    Assumptions
                  </p>
                  <p className="text-xs font-medium text-slate-700">
                    {selectedBatchResult.assumptions.join("; ")}
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        <section className="grid min-h-[620px] gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="overflow-hidden rounded-md border border-slate-300 bg-slate-200 shadow-sm">
            {mapboxToken ? (
              <div ref={mapContainerRef} className="h-[620px] w-full" />
            ) : (
              <div className="flex h-[620px] items-center justify-center bg-slate-100 p-6 text-center text-sm font-medium text-slate-600">
                Mapbox token required. Add NEXT_PUBLIC_MAPBOX_TOKEN to .env.local.
              </div>
            )}
          </div>

          <aside className="flex min-h-[620px] flex-col gap-3">
            <Panel title="Facets">
              <div className="flex flex-col gap-2">
                {calculatedFacets.length === 0 ? (
                  <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">
                    Enter an address to estimate the roof footprint automatically. If no building footprint is available, the result will be marked unusable.
                  </div>
                ) : null}

                {calculatedFacets.map((facet, index) => (
                  <div
                    key={facet.id}
                    className="grid gap-2 rounded-md border border-slate-200 bg-slate-50 p-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <span className="text-sm font-semibold text-slate-900">
                          Structure {index + 1}
                        </span>
                        <p className="text-[11px] font-medium text-slate-500">
                          {facet.role}
                          {facet.distanceFromAddressMeters !== null
                            ? `, ${formatNumber(facet.distanceFromAddressMeters, 0)} m away`
                            : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => updateFacetIncluded(facet.id, !facet.included)}
                          className={`rounded-md border px-2 py-1 text-xs font-bold ${
                            facet.included
                              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                              : "border-slate-200 bg-white text-slate-500"
                          }`}
                        >
                          {facet.included ? "Included" : "Excluded"}
                        </button>
                        <button
                          onClick={() => deleteFacet(facet.id)}
                          className="rounded-md border border-red-200 bg-white px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <p className="rounded-md bg-white px-2 py-1 text-[11px] font-medium text-slate-600">
                      {facet.includeReason}
                    </p>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <Readout
                        label="Building footprint"
                        value={`${formatNumber(facet.buildingFootprintSqft)} sqft`}
                      />
                      <Readout
                        label="With overhang"
                        value={`${formatNumber(facet.footprintSqft)} sqft`}
                      />
                      <Readout
                        label="Roof surface"
                        value={`${formatNumber(facet.roofSurfaceSqft)} sqft`}
                      />
                      <Readout label="Included" value={facet.included ? "Yes" : "No"} />
                    </div>

                    <div className="grid grid-cols-[1fr_0.75fr] gap-2">
                      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-normal text-slate-500">
                        Pitch
                        <select
                          value={facet.pitch}
                          onChange={(event) =>
                            updateFacetPitch(facet.id, event.target.value as PitchValue)
                          }
                          className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm font-medium normal-case text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                        >
                          {PITCH_OPTIONS.map((option) => (
                            <option key={option.label} value={option.label}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Readout
                        label="Multiplier"
                        value={formatNumber(facet.pitchMultiplier, 3)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel title="Accuracy Engine">
              {autoRoofProfile ? (
                <div className="grid gap-2">
                  <div className="grid grid-cols-2 gap-2">
                    <Readout label="Auto profile" value={autoRoofProfile.label} strong />
                    <Readout
                      label="Expected error"
                      value={`+/- ${formatNumber(autoRoofProfile.expectedErrorPercent)} percent`}
                      strong
                    />
                    <Readout label="Auto pitch" value={autoRoofProfile.pitch} />
                    <Readout
                      label="Auto adjustment"
                      value={`${formatNumber(autoRoofProfile.calibrationAdjustmentPercent)} percent`}
                    />
                  </div>
                  <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
                    {autoRoofProfile.reasons.map((reason) => (
                      <p key={reason} className="text-xs font-medium text-slate-600">
                        {reason}
                      </p>
                    ))}
                    <p className="mt-1 text-xs font-semibold text-slate-700">
                      This is still footprint-based, not AI roof-plane segmentation.
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-600">
                  Estimate an address to generate an automatic roof profile, confidence band, and adjustment reasons.
                </p>
              )}
            </Panel>

            <Panel title="Output Summary">
              <div className="grid grid-cols-2 gap-2">
                <Readout
                  label="Building footprint"
                  value={`${formatNumber(totals.totalBuildingFootprintSqft)} sqft`}
                />
                <Readout
                  label="With overhang"
                  value={`${formatNumber(totals.totalFootprintSqft)} sqft`}
                  strong
                />
                <label className="flex flex-col gap-1 rounded-md border border-slate-200 bg-white p-2 text-xs font-semibold uppercase tracking-normal text-slate-500">
                  Overhang inches
                  <input
                    value={overhangInches}
                    onChange={(event) => setOverhangInches(event.target.value)}
                    inputMode="decimal"
                    className={`h-8 rounded-md border px-2 text-sm font-semibold normal-case text-slate-900 outline-none focus:ring-2 ${
                      overhangInvalid
                        ? "border-red-300 focus:border-red-500 focus:ring-red-100"
                        : "border-slate-300 focus:border-blue-500 focus:ring-blue-100"
                    }`}
                  />
                </label>
                <Readout
                  label="Base roof surface"
                  value={`${formatNumber(totals.baseRoofSurfaceSqft)} sqft`}
                />
                <label className="flex flex-col gap-1 rounded-md border border-slate-200 bg-white p-2 text-xs font-semibold uppercase tracking-normal text-slate-500">
                  Calibration percent
                  <input
                    value={calibrationAdjustmentPercent}
                    onChange={(event) => setCalibrationAdjustmentPercent(event.target.value)}
                    inputMode="decimal"
                    className={`h-8 rounded-md border px-2 text-sm font-semibold normal-case text-slate-900 outline-none focus:ring-2 ${
                      calibrationInvalid
                        ? "border-red-300 focus:border-red-500 focus:ring-red-100"
                        : "border-slate-300 focus:border-blue-500 focus:ring-blue-100"
                    }`}
                  />
                </label>
                <Readout
                  label="Calibrated roof"
                  value={`${formatNumber(totals.totalRoofSurfaceSqft)} sqft`}
                  strong
                />
                <Readout
                  label="Roofing squares"
                  value={formatNumber(totals.roofingSquares, 1)}
                />
                <label className="flex flex-col gap-1 rounded-md border border-slate-200 bg-white p-2 text-xs font-semibold uppercase tracking-normal text-slate-500">
                  Waste factor
                  <input
                    value={wasteFactor}
                    onChange={(event) => setWasteFactor(event.target.value)}
                    inputMode="decimal"
                    className={`h-8 rounded-md border px-2 text-sm font-semibold normal-case text-slate-900 outline-none focus:ring-2 ${
                      wasteInvalid
                        ? "border-red-300 focus:border-red-500 focus:ring-red-100"
                        : "border-slate-300 focus:border-blue-500 focus:ring-blue-100"
                    }`}
                  />
                </label>
                <Readout
                  label="Waste adjusted"
                  value={`${formatNumber(totals.wasteAdjustedSqft)} sqft`}
                />
                <Readout
                  label="Waste squares"
                  value={formatNumber(totals.wasteAdjustedRoofingSquares, 1)}
                />
              </div>
              {wasteInvalid ? (
                <p className="mt-2 text-xs font-medium text-red-700">
                  Waste factor must be between 0 and 30 percent.
                </p>
              ) : null}
              {overhangInvalid ? (
                <p className="mt-2 text-xs font-medium text-red-700">
                  Overhang must be between 0 and 36 inches.
                </p>
              ) : null}
              {calibrationInvalid ? (
                <p className="mt-2 text-xs font-medium text-red-700">
                  Calibration adjustment must be between -30 and 30 percent.
                </p>
              ) : null}
            </Panel>

            <Panel title="Comparison">
              {comparison ? (
                <div className="grid gap-2">
                  <div className="grid grid-cols-2 gap-2">
                    <Readout
                      label="Existing tool"
                      value={`${formatNumber(comparison.existing)} sqft`}
                    />
                    <Readout
                      label="Our calibrated"
                      value={`${formatNumber(totals.totalRoofSurfaceSqft)} sqft`}
                    />
                    <Readout
                      label="Difference"
                      value={`${formatNumber(comparison.differenceSqft)} sqft`}
                      strong
                    />
                    <Readout
                      label="Difference percent"
                      value={`${formatNumber(comparison.differencePercent, 1)} percent`}
                      strong
                    />
                  </div>
                  <span
                    className={`w-fit rounded-md border px-2 py-1 text-xs font-bold ${getStatusClasses(
                      comparison.status,
                    )}`}
                  >
                    {comparison.status}
                  </span>
                </div>
              ) : (
                <p className="text-sm text-slate-600">
                  Enter existing tool sqft to compare against the calculated roof surface area.
                </p>
              )}
            </Panel>

            <Panel title="Confidence">
              <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-normal text-slate-500">
                Manual confidence
                <select
                  value={confidence}
                  onChange={(event) => setConfidence(event.target.value as Confidence)}
                  className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold normal-case text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                >
                  {Object.keys(CONFIDENCE_HELP).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <p className="mt-2 text-xs font-medium text-slate-600">
                {CONFIDENCE_HELP[confidence]}
              </p>
            </Panel>

            <div className="rounded-md border border-slate-200 bg-white p-3 shadow-sm">
              <button
                onClick={saveMeasurement}
                className="h-11 w-full rounded-md bg-blue-700 px-4 text-sm font-bold text-white hover:bg-blue-800"
              >
                Save Measurement
              </button>
              {saveMessage ? (
                <p
                  className={`mt-2 text-xs font-semibold ${
                    saveMessage === "Measurement saved." ||
                    saveMessage === "Loaded saved measurement."
                      ? "text-emerald-700"
                      : "text-red-700"
                  }`}
                >
                  {saveMessage}
                </p>
              ) : null}
            </div>
          </aside>
        </section>

        <section className="rounded-md border border-slate-200 bg-white p-3 shadow-sm">
          <div className="mb-3 flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
            <div>
              <h2 className="text-base font-semibold text-slate-950">Saved Measurements</h2>
              <p className="text-xs text-slate-500">
                Stored in this browser for MVP calibration work.
              </p>
            </div>
            <button
              onClick={exportCsv}
              disabled={savedMeasurements.length === 0}
              className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
            >
              Export CSV
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-y border-slate-200 bg-slate-50 text-xs uppercase tracking-normal text-slate-500">
                  <TableHeader>Address</TableHeader>
                  <TableHeader>Our sqft</TableHeader>
                  <TableHeader>Existing tool sqft</TableHeader>
                  <TableHeader>Difference percent</TableHeader>
                  <TableHeader>Status</TableHeader>
                  <TableHeader>Confidence</TableHeader>
                  <TableHeader>Created date</TableHeader>
                  <TableHeader>View</TableHeader>
                  <TableHeader>Delete</TableHeader>
                </tr>
              </thead>
              <tbody>
                {savedMeasurements.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-6 text-center text-sm text-slate-500">
                      No saved measurements yet.
                    </td>
                  </tr>
                ) : null}

                {savedMeasurements.map((measurement) => (
                  <tr key={measurement.id} className="border-b border-slate-100">
                    <TableCell>
                      <span className="block max-w-[360px] truncate font-medium text-slate-900">
                        {measurement.address}
                      </span>
                    </TableCell>
                    <TableCell>{formatNumber(measurement.totalRoofSurfaceSqft)} sqft</TableCell>
                    <TableCell>
                      {measurement.existingToolSqft
                        ? `${formatNumber(measurement.existingToolSqft)} sqft`
                        : "Not entered"}
                    </TableCell>
                    <TableCell>
                      {measurement.differencePercent === null
                        ? "Not compared"
                        : `${formatNumber(measurement.differencePercent, 1)} percent`}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`rounded-md border px-2 py-1 text-xs font-bold ${getStatusClasses(
                          measurement.status,
                        )}`}
                      >
                        {measurement.status ?? "None"}
                      </span>
                    </TableCell>
                    <TableCell>{measurement.confidence}</TableCell>
                    <TableCell>{new Date(measurement.createdAt).toLocaleString()}</TableCell>
                    <TableCell>
                      <button
                        onClick={() => viewMeasurement(measurement)}
                        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                      >
                        View
                      </button>
                    </TableCell>
                    <TableCell>
                      <button
                        onClick={() => deleteMeasurement(measurement.id)}
                        className="rounded-md border border-red-200 bg-white px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50"
                      >
                        Delete
                      </button>
                    </TableCell>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-3 shadow-sm">
      <h2 className="mb-2 text-sm font-bold uppercase tracking-normal text-slate-700">
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
