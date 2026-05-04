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

type Facet = {
  id: string;
  feature: RoofFeature;
  pitch: PitchValue;
  included: boolean;
  source: "address" | "nearby" | "saved";
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

  const facets = selectedCandidates.map((candidate, index) => ({
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
    included: index === 0,
    source: candidate.containsAddressPoint ? "address" : "nearby",
  })) satisfies Facet[];

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
  const [isSearching, setIsSearching] = useState(false);

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
          drawRef.current?.deleteAll();
          autoEstimate.facets.forEach((facet) => drawRef.current?.add(facet.feature));
          setFacets(autoEstimate.facets);
          setConfidence("Medium");
          setAutoEstimateMessage(autoEstimate.source);
        } else {
          drawRef.current?.deleteAll();
          setFacets([]);
          setConfidence("Unusable");
          setAutoEstimateMessage(autoEstimate.reason);
        }
      }
    } catch {
      setSearchError("Search failed. Confirm the Mapbox token and try again.");
    } finally {
      setIsSearching(false);
    }
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
      })),
    );
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
                          {facet.source === "address" ? "Address match" : "Nearby structure"}
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
