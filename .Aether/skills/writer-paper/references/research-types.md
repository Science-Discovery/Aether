# Paper Structure by Research Type

## Table of Contents
1. Research Type Classification
2. Theoretical/Mathematical Research
3. Computational/Numerical Research
4. Experimental Research
5. Review/Survey Research
6. Mixed/Case Study

## 1. Research Type Classification

Classify the research type based on available materials:

| Signal | Research Type |
|--------|--------------|
| Derivations file + heavy math content | Theoretical |
| Numerical results + code output + performance metrics | Computational |
| Experimental data + measurements + statistical tests | Experimental |
| Literature-focused + synthesis + no primary data | Review |
| Multiple types or unclear | Mixed |

Use AI to classify by providing: topic, file list with types, whether derivations and discussion documents exist. Output JSON:

```json
{
  "researchType": "experimental|theoretical|computational|review|case_study|mixed",
  "templateName": "Standard Research Paper|Technical Report|Review Article|...",
  "sections": ["Abstract", "Introduction", "Methods", "Results", "Discussion", "Conclusion"],
  "suggestedReferences": []
}
```

Default fallback (when classification fails): `["Abstract", "Introduction", "Background", "Methods", "Results", "Discussion", "Conclusion"]`

## 2. Theoretical/Mathematical Research

**Sections**: Abstract → Introduction → Preliminaries → Main Results → Applications/Examples → Discussion → Conclusion

- **Abstract**: State the main theoretical contribution and key results
- **Introduction**: Motivation, research gap, main theorem/result preview
- **Preliminaries**: Definitions, notation, background theorems
- **Main Results**: Theorems, lemmas, proofs (reference detailed_derivations)
- **Applications/Examples**: Concrete cases demonstrating the theory
- **Discussion**: Implications, limitations, connections to other work
- **Conclusion**: Summary of contributions, open problems

## 3. Computational/Numerical Research

**Sections**: Abstract → Introduction → Methods → Results → Discussion → Conclusion

- **Abstract**: Problem, method, key numerical results
- **Introduction**: Problem motivation, existing approaches, your contribution
- **Methods**: Algorithm description, implementation details, parameters
- **Results**: Numerical experiments, performance metrics, comparisons
- **Discussion**: Analysis of results, limitations, computational cost
- **Conclusion**: Summary, future work

## 4. Experimental Research

**Sections**: Abstract → Introduction → Materials and Methods → Results → Discussion → Conclusion

- **Abstract**: Hypothesis, experimental approach, main findings
- **Introduction**: Background, research question, hypothesis
- **Materials and Methods**: Experimental setup, procedures, measurements
- **Results**: Data presentation, statistical analysis
- **Discussion**: Interpretation, comparison with literature, limitations
- **Conclusion**: Summary, implications, future directions

## 5. Review/Survey Research

**Sections**: Abstract → Introduction → Background → Main Body → Discussion → Conclusion

- **Abstract**: Scope, methodology, key insights
- **Introduction**: Topic importance, review scope, organization
- **Background**: Historical development, key concepts
- **Main Body**: Thematic or chronological organization of literature
- **Discussion**: Synthesis, trends, gaps, future directions
- **Conclusion**: Summary of insights, recommendations

## 6. Mixed/Case Study

**Sections**: Abstract → Introduction → Background → Methods → Results → Discussion → Conclusion

Use the default section order and adapt section content based on the dominant research characteristics. Combine elements from the relevant types above.
